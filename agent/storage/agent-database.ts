import { assertPrivateStateLocksHeld } from '../../core/private-state-lock-context.ts';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { backup, DatabaseSync } from 'node:sqlite';

import { and, eq, sql } from 'drizzle-orm';
import { omit } from 'lodash-es';
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
import {
  automationReports,
  githubIdentityPins,
  pathProjections,
  directEntries,
  dispatchRecords,
  dispatchState,
  intakeRecords,
  intakeState,
} from './schema.ts';
import {
  assignmentClaims,
  instances,
  managedRepositories,
  sidebarPlacements,
} from './installation-schema.ts';
import type { AssignmentClaimState } from '../tasks/dispatch/assignment-claim-store.ts';
import type {
  BoundStorage,
  SidebarPlacementChange,
  SqliteInstallation,
  StorageSchema,
} from './storage-lifecycle.ts';
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
          client: new DatabaseSync(this.path, { readOnly, timeout: 5000 }),
        }),
        empty: stat.size === 0,
      };
    } finally {
      await file.close();
    }
  }

  async exportSnapshot(destination: string) {
    await this.checkDirectory();
    const { db } = await this.connect(false, true);
    try {
      await (await open(destination, 'wx', 0o600)).close();
      await backup(db.$client, destination);
    } finally {
      db.$client.close();
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

type JournalTable = typeof intakeRecords | typeof dispatchRecords;
type JournalRecord = IntakeState['records'][number] | AgentRows['dispatchRecords']['value'];
type Transaction = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0];

// Readers return rowid order. Keep the longest surviving prefix in place, then append
// the rest in requested order (including a deliberate reorder or insertion in the middle).
function saveJournalRows(
  tx: Transaction,
  table: JournalTable,
  scope: string,
  records: JournalRecord[],
) {
  const previous = tx
    .select({ id: table.id, value: sql<string>`${table.value}` })
    .from(table)
    .where(eq(table.scope, scope))
    .orderBy(sql`rowid`)
    .all();
  const positions = new Map(previous.map((row, index) => [row.id, index]));
  const retained = new Set<string>();
  let last = -1;
  for (const record of records) {
    const position = positions.get(record.id);
    if (position === undefined || position <= last) break;
    last = position;
    retained.add(record.id);
    if (previous[position]!.value !== JSON.stringify(record))
      tx.update(table)
        .set({ value: record })
        .where(and(eq(table.scope, scope), eq(table.id, record.id)))
        .run();
  }
  for (const { id } of previous)
    if (!retained.has(id))
      tx.delete(table)
        .where(and(eq(table.scope, scope), eq(table.id, id)))
        .run();
  for (const record of records.slice(retained.size))
    tx.insert(table).values({ scope, id: record.id, value: record }).run();
}

class SqliteAgentStore extends SqliteDatabase {
  private readonly records = sqliteRecords<AgentRows>(agentTables, this.use.bind(this));
  readonly read = this.records.read;
  readonly write = this.records.write;

  replacePathProjection(value: AgentRows['pathProjections']['value']) {
    return this.use(false, (db) =>
      db.transaction((tx) => {
        assertPrivateStateLocksHeld();
        // The OpenClaw agent has one current PATH prefix, including after a workspace move.
        tx.delete(pathProjections).run();
        tx.insert(pathProjections).values({ scope: value.workspaceDir, value }).run();
      }),
    );
  }

  changeReport(
    id: string,
    change: (row?: AgentRows['automationReports']) => AgentRows['automationReports'] | undefined,
  ) {
    return this.use(false, (db) =>
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          const key = eq(automationReports.executionId, id);
          const current = tx.select().from(automationReports).where(key).get();
          const next = change(current);
          if (next === current) return;
          if (!next) {
            if (current) tx.delete(automationReports).where(key).run();
          } else {
            if (next.executionId !== id) throw new Error('automation-report-record-invalid');
            if (current) tx.update(automationReports).set(next).where(key).run();
            else tx.insert(automationReports).values(next).run();
          }
        },
        { behavior: 'immediate' },
      ),
    );
  }

  retainIdentityPin(
    row: AgentRows['githubIdentityPins'],
    validate: (entries: Record<string, AgentRows['githubIdentityPins']['value']>) => void,
  ) {
    return this.use(false, (db) =>
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          const pins = tx
            .select()
            .from(githubIdentityPins)
            .where(eq(githubIdentityPins.scope, row.scope))
            .all();
          const entries = Object.fromEntries(pins.map(({ id, value }) => [id, value]));
          const current = entries[row.id];
          if (current && current.nodeId !== row.value.nodeId)
            throw new Error('github-identity-conflict');
          if (isDeepStrictEqual(current, row.value)) return;
          validate({ ...entries, [row.id]: row.value });
          tx.insert(githubIdentityPins)
            .values(row)
            .onConflictDoUpdate({
              target: [githubIdentityPins.scope, githubIdentityPins.id],
              set: { value: row.value },
            })
            .run();
        },
        { behavior: 'immediate' },
      ),
    );
  }

  listReportIds(selection: 'all' | 'recoverable' | { completedBefore: string }) {
    const terminal = sql`${automationReports.state} in ('delivered', 'failed')`;
    const completedAt = automationReports.completedAt;
    // Legacy terminal reports get a completion date on first reconciliation.
    // File reports accept all Date.parse timestamps. Let pruneOne check legacy formats
    // SQLite cannot parse, alongside records whose ISO completion time is already due.
    const where =
      selection === 'recoverable'
        ? sql`not (${terminal}) or ${completedAt} is null`
        : selection === 'all'
          ? undefined
          : sql`${terminal} and ${completedAt} is not null and coalesce(julianday(${completedAt}), 0) <= julianday(${selection.completedBefore})`;
    return this.use(true, (db) =>
      db
        .select({ id: automationReports.executionId })
        .from(automationReports)
        .where(where)
        .all()
        .map(({ id }) => id),
    );
  }

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
        if (records.some((record) => record.scope !== state.scope))
          throw new Error('intake record scope mismatch');
        saveJournalRows(tx, intakeRecords, state.scope, records);
      }),
    );
  }

  saveDispatch(
    scope: string,
    {
      records,
      ...value
    }: AgentRows['dispatchState']['value'] & { records: AgentRows['dispatchRecords']['value'][] },
  ) {
    return this.use(false, (db) =>
      db.transaction((tx) => {
        assertPrivateStateLocksHeld();
        tx.insert(dispatchState)
          .values({ scope, value })
          .onConflictDoUpdate({ target: dispatchState.scope, set: { value } })
          .run();
        saveJournalRows(tx, dispatchRecords, scope, records);
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

  changeSidebarPlacement(scope: string, change: SidebarPlacementChange) {
    return this.use(false, (db) =>
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          const current = tx
            .select()
            .from(sidebarPlacements)
            .where(eq(sidebarPlacements.scope, scope))
            .get();
          const { value, result } = change(current?.value);
          if (value) {
            tx.insert(sidebarPlacements)
              .values({ scope, value })
              .onConflictDoUpdate({
                target: sidebarPlacements.scope,
                set: { value },
              })
              .run();
          }
          return result;
        },
        { behavior: 'immediate' },
      ),
    );
  }

  saveAssignmentClaims(state: AssignmentClaimState, previous?: AssignmentClaimState) {
    const { claims, ...identity } = state;
    return this.use(false, (db) =>
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          const identities = tx.select().from(instances).limit(2).all();
          if (!previous) {
            if (identities.length) throw new Error('claim-checkpoint-conflict');
            tx.insert(instances).values({ id: identity.instanceId, value: identity }).run();
          } else {
            const expected = omit(previous, 'claims');
            const current = identities[0];
            if (
              identities.length !== 1 ||
              current?.id !== expected.instanceId ||
              !isDeepStrictEqual(current.value, expected)
            )
              throw new Error('claim-checkpoint-conflict');
            if (!isDeepStrictEqual(identity, expected))
              tx.update(instances)
                .set({ id: identity.instanceId, value: identity })
                .where(eq(instances.id, expected.instanceId))
                .run();
          }

          for (const id of new Set([
            ...Object.keys(previous?.claims ?? {}),
            ...Object.keys(claims),
          ])) {
            const before = previous?.claims[id];
            const after = claims[id];
            if (isDeepStrictEqual(before, after)) continue;
            if (!before && after) {
              const inserted = tx
                .insert(assignmentClaims)
                .values({ id, value: after })
                .onConflictDoNothing()
                .run();
              if (!inserted.changes) throw new Error('claim-checkpoint-conflict');
              continue;
            }

            const key = eq(assignmentClaims.id, id);
            const current = tx.select().from(assignmentClaims).where(key).get();
            if (!current || !isDeepStrictEqual(current.value, before))
              throw new Error('claim-checkpoint-conflict');
            if (after) tx.update(assignmentClaims).set({ value: after }).where(key).run();
            else tx.delete(assignmentClaims).where(key).run();
          }
        },
        { behavior: 'immediate' },
      ),
    );
  }

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
      assertPrivateStateLocksHeld();
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
): BoundStorage &
  Record<keyof BoundStorage, StorageSchema & Pick<SqliteDatabase, 'exportSnapshot'>> {
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

export async function* sqliteAgentDatabases(installation: SqliteInstallation) {
  const names = await readdir(installation.agentRoot).catch((error: unknown) => {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
    return [];
  });
  for (const name of names) {
    const match = /^([a-z0-9][a-z0-9-]*)\.sqlite$/u.exec(name);
    if (match) {
      const agentId = match[1]!;
      yield { agentId, agent: bindSqliteStorage(installation, agentId).agent };
    }
  }
}
