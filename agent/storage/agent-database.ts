import { assertPrivateStateLocksHeld } from '../../core/private-state-lock-context.ts';
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
import * as agentTables from './schema.ts';
import * as installationTables from './installation-schema.ts';
import sqliteRecords from './sqlite-records.ts';
import type { AgentRows, InstallationRows } from './workflow-records.ts';
import { directEntries, intakeRecords, intakeState } from './schema.ts';
import { managedRepositories } from './installation-schema.ts';
import type { BoundStorage, SqliteInstallation, StorageSchema } from './storage-lifecycle.ts';
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
    private readonly filename: string,
    private readonly component: 'agent-storage' | 'agent-system-storage',
    private readonly migrationsFolder: string,
  ) {
    this.path = join(root, filename);
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
          message: '`' + this.filename + '` is missing',
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
              '`' +
              this.filename +
              '` has pending migrations for Agent System ' +
              packageMetadata.version +
              ': ' +
              pending.map((m) => m.name).join(', '),
            remediation,
          };
        return {
          component,
          code: component + '-ready',
          status: 'healthy',
          message: '`' + this.filename + '` is ready',
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
          'cannot inspect `' +
          this.filename +
          '`' +
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
        message: '`' + this.filename + '` is ready',
      };
    } finally {
      db.$client.close();
    }
  }
}

class SqliteAgentStore extends SqliteDatabase {
  private readonly records = sqliteRecords<AgentRows>(agentTables, this.use.bind(this));
  readonly read = this.records.read;
  readonly write = this.records.write;

  async readReplies(scope: string) {
    const { replyDrafts } = await this.read({ replyDrafts: { scope } });
    return replyDrafts
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, value }) => {
        if (value?.id !== id) throw new Error('reply-state-invalid');
        return value;
      });
  }

  saveReplies(scope: string, changed: AgentRows['replyDrafts']['value'][], removed: string[]) {
    return this.write([
      ...changed.map((value) => ({
        table: 'replyDrafts' as const,
        action: 'save' as const,
        row: { scope, id: value.id, value },
      })),
      ...removed.map((id) => ({
        table: 'replyDrafts' as const,
        action: 'remove' as const,
        key: { scope, id },
      })),
    ]);
  }

  async readDirectEntries(scope: string, kind: AgentRows['directEntries']['kind']) {
    const rows = await this.read({ directEntries: { scope, kind } });
    return rows.directEntries.map(({ id, value }) => {
      if (id !== ('id' in value ? value.id : value.digest))
        throw new Error(kind + '-state-invalid');
      return value;
    });
  }

  saveDirectEntries(
    scope: string,
    kind: AgentRows['directEntries']['kind'],
    entries: AgentRows['directEntries']['value'][],
  ) {
    return this.use(false, (db) =>
      db.transaction((tx) => {
        assertPrivateStateLocksHeld();
        tx.delete(directEntries)
          .where(and(eq(directEntries.scope, scope), eq(directEntries.kind, kind)))
          .run();
        for (const value of entries)
          tx.insert(directEntries)
            .values({ scope, kind, id: 'id' in value ? value.id : value.digest, value })
            .run();
      }),
    );
  }

  listIntakeScopes() {
    return this.use(true, (db) =>
      db
        .select({ scope: intakeState.scope })
        .from(intakeState)
        .all()
        .map((row) => row.scope),
    );
  }

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
        assertPrivateStateLocksHeld();
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
  private readonly records = sqliteRecords<InstallationRows>(
    installationTables,
    this.use.bind(this),
  );
  readonly read = this.records.read;
  readonly write = this.records.write;

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

export function bindSqliteInstallation(installation: SqliteInstallation) {
  return new SqliteInstallationStore(
    installation.installationRoot,
    'agent-system.sqlite',
    'agent-system-storage',
    join(installation.schemaRoot, 'installation-migrations'),
  );
}

export function bindSqliteStorage(
  installation: SqliteInstallation,
  agentId: string,
): BoundStorage & Record<keyof BoundStorage, StorageSchema> {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) throw new Error('invalid agent database name');
  return {
    agent: new SqliteAgentStore(
      installation.agentRoot,
      agentId + '.sqlite',
      'agent-storage',
      join(installation.schemaRoot, 'migrations'),
    ),
    installation: bindSqliteInstallation(installation),
  };
}
