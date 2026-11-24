import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { and, eq, sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

import ensurePrivateStateDirectories, {
  assertPrivateDirectory,
} from '../../core/ensure-private-state-directories.ts';
import packageMetadata from '../../package.json' with { type: 'json' };
import { automationHash } from '../automation-hash.ts';
import { intakeRecords, intakeState } from './schema.ts';
import { managedRepositories } from './installation-schema.ts';
import type { BoundStorage, StorageBinding, StorageSchema } from './storage-lifecycle.ts';
import type { IntakeState } from '../../channels/github/intake/record-store.ts';
import type { RepositoryRecord } from '../../tools/git/repository-service.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';
import type {
  AgentSystemLifecycleFinding,
  AgentSystemLifecycleOutcome,
} from '../../core/lifecycle-registry.ts';

function pendingMigrations(client: DatabaseSync, migrationsFolder: string) {
  const migrations = readMigrationFiles({ migrationsFolder });
  if (!migrations.length) throw new Error('no packaged migrations in ' + migrationsFolder);
  const journal = client
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  const applied = new Set(
    journal
      ? client
          .prepare('SELECT name FROM __drizzle_migrations')
          .all()
          .map((row) => row.name)
      : [],
  );
  return migrations.filter((migration) => !applied.has(migration.name));
}

class SqliteDatabase {
  readonly path: string;

  constructor(
    private readonly root: string,
    name: string,
    private readonly component: 'agent-storage' | 'installation-storage',
    private readonly migrationsFolder: string,
  ) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error('invalid agent database name');
    this.path = join(root, name + '.sqlite');
  }

  /** Normal clients open an installed database; only Install creates it. */
  protected async use<T>(readOnly: boolean, operation: (db: ReturnType<typeof drizzle>) => T) {
    await this.checkDirectory();
    const { db } = await this.connect(false, readOnly);
    try {
      return operation(db);
    } finally {
      db.$client.close();
    }
  }

  private async checkDirectory() {
    assertPrivateDirectory(await lstat(this.root), {
      currentUid: process.getuid?.(),
      label: 'agent storage',
    });
  }

  private async connect(create: boolean, readOnly = false) {
    const flags =
      (readOnly ? constants.O_RDONLY : constants.O_RDWR) |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK;
    const file = await open(this.path, create ? flags | constants.O_CREAT : flags, 0o600);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error('agent storage requires a private, owned database file');
      return {
        db: drizzle({
          client: new DatabaseSync(this.path, { readOnly, ...(create ? { timeout: 5000 } : {}) }),
        }),
        empty: stat.size === 0,
      };
    } finally {
      await file.close();
    }
  }

  async inspect(): Promise<AgentSystemLifecycleFinding> {
    const component = this.component;
    const remediation = 'run Agent System install';
    try {
      let connection;
      try {
        await this.checkDirectory();
        connection = await this.connect(false, true);
      } catch (error) {
        if (nodeErrorCode(error) !== 'ENOENT') throw error;
        return {
          component,
          code: component + '-missing',
          status: 'drift',
          message: 'database missing: ' + this.path,
          remediation,
        };
      }
      const client = connection.db.$client;
      try {
        const pending = pendingMigrations(client, this.migrationsFolder);
        if (pending.length)
          return {
            component,
            code: component + '-migrations-pending',
            status: 'drift',
            message:
              'pending migrations for Agent System ' +
              packageMetadata.version +
              ': ' +
              pending.map((m) => m.name).join(', '),
            remediation,
          };
        return {
          component,
          code: component + '-ready',
          status: 'healthy',
          message: 'database: ' + this.path,
        };
      } finally {
        client.close();
      }
    } catch (error) {
      return {
        component,
        code: component + '-inspection-failed',
        status: 'blocked',
        message:
          'cannot inspect ' +
          this.path +
          ': ' +
          (error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async install(): Promise<AgentSystemLifecycleOutcome> {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'agent storage',
    });
    const { db, empty } = await this.connect(true);
    try {
      if (pendingMigrations(db.$client, this.migrationsFolder).length) {
        // Hold SQLite's writer lock across Drizzle's journal read and its own transaction.
        // Two agents can install the same installation database at the same time.
        db.$client.exec('PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');
        migrate(db, { migrationsFolder: this.migrationsFolder });
      }
      const changes = db.$client.prepare('SELECT total_changes() AS changes').get()?.changes;
      return {
        component: this.component,
        code: this.component + '-ready',
        status: changes ? (empty ? 'created' : 'updated') : 'unchanged',
        message: `database: ${this.path}`,
      };
    } finally {
      db.$client.close();
    }
  }
}

class SqliteAgentStore extends SqliteDatabase {
  readIntake(scope: string) {
    return this.use(true, (db) =>
      db.transaction((tx) => {
        const state = tx.select().from(intakeState).where(eq(intakeState.scope, scope)).get();
        if (!state) return undefined;
        const records = tx
          .select({ value: intakeRecords.value })
          .from(intakeRecords)
          .where(eq(intakeRecords.scope, scope))
          .orderBy(sql`rowid`)
          .all();
        return { ...state.value, records: records.map((row) => row.value) };
      }),
    );
  }

  saveIntake({ records, ...state }: IntakeState) {
    return this.use(false, (db) =>
      db.transaction((tx) => {
        tx.insert(intakeState)
          .values({ scope: state.scope, value: state })
          .onConflictDoUpdate({ target: intakeState.scope, set: { value: state } })
          .run();
        tx.delete(intakeRecords).where(eq(intakeRecords.scope, state.scope)).run();
        for (const record of records) {
          if (record.scope !== state.scope) throw new Error('intake record scope mismatch');
          tx.insert(intakeRecords)
            .values({ scope: state.scope, id: record.id, value: record })
            .run();
        }
      }),
    );
  }

  clearIntake(scope: string) {
    return this.use(false, (db) =>
      db.transaction((tx) => {
        tx.delete(intakeRecords).where(eq(intakeRecords.scope, scope)).run();
        tx.delete(intakeState).where(eq(intakeState.scope, scope)).run();
      }),
    );
  }
}

class SqliteInstallationStore extends SqliteDatabase {
  readRepository(root: string, id: string) {
    return this.use(
      true,
      (db) =>
        db
          .select()
          .from(managedRepositories)
          .where(and(eq(managedRepositories.root, root), eq(managedRepositories.id, id)))
          .get()?.value,
    );
  }

  saveRepository(root: string, record: RepositoryRecord) {
    return this.use(false, (db) => {
      db.insert(managedRepositories)
        .values({ root, id: record.repositoryId, value: record })
        .onConflictDoUpdate({
          target: [managedRepositories.root, managedRepositories.id],
          set: { value: record },
        })
        .run();
    });
  }
}

export function bindSqliteStorage(
  installation: { agentRoot: string; installationRoot: string; schemaRoot: string },
  binding: StorageBinding,
): BoundStorage & Record<keyof BoundStorage, StorageSchema> {
  const name =
    binding.runtime === 'codex'
      ? automationHash([binding.agentId, binding.workspaceDir])
      : binding.agentId;
  return {
    agent: new SqliteAgentStore(
      installation.agentRoot,
      name,
      'agent-storage',
      join(installation.schemaRoot, 'migrations'),
    ),
    installation: new SqliteInstallationStore(
      installation.installationRoot,
      'installation',
      'installation-storage',
      join(installation.schemaRoot, 'installation-migrations'),
    ),
  };
}
