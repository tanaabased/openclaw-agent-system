import { agentWorkflowLockPath, type AgentLockFamily } from './workflow-lock.ts';
import { maximumLedgerBytes, type RegistrationLedger } from './automation-backend.ts';
import { AutomationError, CodexAutomationError } from '../automations/automation-errors.ts';
import type { DispatchEnvelope } from './dispatch-backend.ts';
import { normalizeDispatchPickup } from '../tasks/dispatch/dispatch-state.ts';
import { stateSnapshotConflictCode } from '../../core/merge-state-snapshot.ts';
import { assertPrivateStateLocksHeld } from '../../core/private-state-lock-context.ts';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  replyPublicationKey,
  replyPublicationReserved,
  stageReplyPublications,
} from './reply-publication.ts';
import { isDeepStrictEqual } from 'node:util';
import { backup, DatabaseSync } from 'node:sqlite';

import { and, eq, inArray, sql } from 'drizzle-orm';
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
  automationRegistrations,
  automationState,
  githubIdentityPins,
  replyDrafts,
  pathProjections,
  pickupEnrollments,
  directEntries,
  dispatchRecords,
  dispatchState,
  intakeRecords,
  intakeState,
  notificationResets,
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
    private readonly prepareMigration?: (pending: string[], client: DatabaseSync) => Promise<void>,
  ) {
    this.path = join(root, filename);
  }

  /** Normal clients open an installed database; only Install creates it. */
  protected async use<T>(
    readOnly: boolean,
    operation: (db: ReturnType<typeof drizzle>) => T | Promise<T>,
  ) {
    await this.checkDirectory();
    const { db } = await this.connect(false, readOnly);
    try {
      return await operation(db);
    } finally {
      db.$client.close();
    }
  }

  protected async checkDirectory() {
    assertPrivateDirectory(await lstat(this.root), {
      currentUid: process.getuid?.(),
      label: 'agent storage',
    });
  }

  protected async withCheckedFile<T>(
    create: boolean,
    readOnly: boolean,
    run: (empty: boolean) => T,
  ) {
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
      return run(stat.size === 0);
    } finally {
      await file.close();
    }
  }

  private async connect(create: boolean, readOnly = false) {
    return this.withCheckedFile(create, readOnly, (empty) => ({
      db: drizzle({ client: new DatabaseSync(this.path, { readOnly, timeout: 5000 }) }),
      empty,
    }));
  }

  saveAutomationLedger(
    runtime: 'codex' | 'openclaw',
    ledger: RegistrationLedger,
    expected: RegistrationLedger,
  ) {
    const { records, ...header } = JSON.parse(JSON.stringify(ledger)) as RegistrationLedger;
    const { records: before, ...expectedHeader } = expected;
    const { scope } = header;
    const ErrorType = runtime === 'codex' ? CodexAutomationError : AutomationError;
    if (scope !== expected.scope || new Set(records.map((r) => r.id)).size !== records.length)
      throw new ErrorType('automation-ownership-invalid');
    return this.use(false, (db) =>
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          const current = tx
            .select()
            .from(automationState)
            .where(eq(automationState.scope, scope))
            .get();
          const rows = tx
            .select()
            .from(automationRegistrations)
            .where(eq(automationRegistrations.scope, scope))
            .orderBy(sql`rowid`)
            .all();
          if ((!current && rows.length) || rows.some((r) => r.id !== r.value?.id))
            throw new ErrorType('automation-ownership-invalid');
          const conflict = () => new ErrorType('automation-journal-busy');
          if (!isDeepStrictEqual(current?.value ?? { version: 1, scope }, expectedHeader))
            throw conflict();
          let merged: AgentRows['automationRegistrations']['value'][] = records;
          const saved = rows.map((row) => row.value);
          if (!isDeepStrictEqual(saved, before)) {
            // A Codex handoff authorizes one action from a plan over the whole ledger.
            if (runtime === 'codex') throw conflict();
            // OpenClaw checkpoints one job at a time. Keep other reconcilers' edits,
            // but never grant a second writer the same job reservation.
            const latest = new Map(saved.map((r) => [r.id, r]));
            const previous = new Map(before.map((r) => [r.id, r] as const));
            const next = new Map(records.map((r) => [r.id, r] as const));
            for (const id of new Set([...previous.keys(), ...next.keys()])) {
              const old = previous.get(id);
              const value = next.get(id);
              if (isDeepStrictEqual(old, value)) continue;
              if (!isDeepStrictEqual(latest.get(id), old)) throw conflict();
              if (value) latest.set(id, value);
              else latest.delete(id);
            }
            merged = [...latest.values()];
          }
          const contents = JSON.stringify({ ...header, records: merged });
          if (Buffer.byteLength(contents) + (runtime === 'openclaw' ? 1 : 0) > maximumLedgerBytes)
            throw new Error('automation ownership exceeds its size limit');
          saveJournalRows(tx, automationRegistrations, scope, merged);
          if (!current || !isDeepStrictEqual(current.value, header))
            tx.insert(automationState)
              .values({ scope, value: header })
              .onConflictDoUpdate({ target: automationState.scope, set: { value: header } })
              .run();
        },
        { behavior: 'immediate' },
      ),
    );
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
      const pending = pendingMigrations(db.$client, this.migrationsFolder);
      if (pending.length) {
        await this.prepareMigration?.(
          pending.map((m) => m.name),
          db.$client,
        );
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

type JournalTable = typeof intakeRecords | typeof dispatchRecords | typeof automationRegistrations;
type JournalRecord =
  | IntakeState['records'][number]
  | AgentRows['dispatchRecords']['value']
  | AgentRows['automationRegistrations']['value'];
type Transaction = Parameters<Parameters<ReturnType<typeof drizzle>['transaction']>[0]>[0];

function readDispatch(tx: Transaction, scope: string) {
  const header = tx.select().from(dispatchState).where(eq(dispatchState.scope, scope)).get();
  const rows = tx
    .select()
    .from(dispatchRecords)
    .where(eq(dispatchRecords.scope, scope))
    .orderBy(sql`rowid`)
    .all();
  if ((!header && rows.length) || rows.some(({ id, value }) => value?.id !== id))
    throw new Error('dispatch-state-invalid');
  return header && { ...header.value, records: rows.map(({ value }) => value) };
}

function readIntake(tx: Transaction, scope: string) {
  const state = tx.select().from(intakeState).where(eq(intakeState.scope, scope)).get();
  if (!state) return undefined;
  const records = tx
    .select({ value: intakeRecords.value })
    .from(intakeRecords)
    .where(eq(intakeRecords.scope, scope))
    .orderBy(sql`rowid`)
    .all();
  return { ...state.value, records: records.map((row) => row.value) };
}

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
  constructor(
    location: SqliteInstallation,
    agentId: string,
    private readonly shared: SqliteInstallationStore,
  ) {
    super(
      location.agentRoot,
      agentId + '.sqlite',
      'agent-storage',
      join(location.schemaRoot, 'migrations'),
    );
  }

  workflowLockPath(family: AgentLockFamily, scope: string) {
    return agentWorkflowLockPath(this.path, family, scope);
  }

  async stageReplyMigration(shared: DatabaseSync) {
    return this.use(true, (db) => stageReplyPublications(shared, db.$client));
  }

  async stageCodexSchedules(shared: DatabaseSync, agentId: string) {
    return this.use(true, (db) =>
      db.transaction((tx) => {
        if (
          !tx.get(
            sql`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'automation_state'`,
          )
        )
          return;
        const header = shared.prepare('INSERT INTO prior_automation_state VALUES (?, ?)');
        const registration = shared.prepare(
          'INSERT INTO prior_automation_registrations VALUES (?, ?, ?)',
        );
        for (const { scope, value } of tx.select().from(automationState).all()) {
          if (value.binding?.agentId !== agentId)
            throw new CodexAutomationError('automation-ownership-invalid');
          header.run(scope, JSON.stringify(value));
          for (const row of tx
            .select()
            .from(automationRegistrations)
            .where(eq(automationRegistrations.scope, scope))
            .orderBy(sql`rowid`)
            .all())
            registration.run(scope, row.id, JSON.stringify(row.value));
        }
      }),
    );
  }

  hasReplyPublication(
    draft: Pick<AgentRows['replyDrafts']['value'], 'authorNodeId' | 'publication'>,
  ) {
    return this.shared.hasReplyPublication(
      replyPublicationKey(draft.authorNodeId, draft.publication),
    );
  }

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

  changePickupEnrollment(
    key: Pick<AgentRows['pickupEnrollments'], 'runtime' | 'scope'>,
    change: (
      current?: AgentRows['pickupEnrollments']['value'],
    ) => AgentRows['pickupEnrollments']['value'],
    validateCapacity?: (records: AgentRows['pickupEnrollments']['value'][]) => void,
  ) {
    return this.use(false, (db) =>
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          const saved = tx
            .select()
            .from(pickupEnrollments)
            .where(
              and(
                eq(pickupEnrollments.runtime, key.runtime),
                eq(pickupEnrollments.scope, key.scope),
              ),
            )
            .get();
          const value = change(saved?.value);
          tx.insert(pickupEnrollments)
            .values({ ...key, value })
            .onConflictDoUpdate({
              target: [pickupEnrollments.runtime, pickupEnrollments.scope],
              set: { value },
            })
            .run();
          // A failed reservation rolls back this row along with the capacity check.
          if (validateCapacity)
            validateCapacity(
              tx
                .select({ value: pickupEnrollments.value })
                .from(pickupEnrollments)
                .all()
                .map((row) => row.value),
            );
          return value;
        },
        { behavior: 'immediate' },
      ),
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

  saveReplies(
    scope: string,
    expected: ReadonlyMap<string, string>,
    changed: AgentRows['replyDrafts']['value'][],
    removed: string[],
    checkSelection: boolean,
  ) {
    // Attach only for a send, definite rejection or provider receipt. SQLite commits
    // the draft and the installation-wide claim together before control returns to GitHub.
    const publications = changed.flatMap((draft) => {
      const prior = expected.get(draft.id);
      const previous = prior ? (JSON.parse(prior) as typeof draft) : undefined;
      const action =
        draft.receipt && !previous?.receipt
          ? 'observe'
          : draft.attempted && !previous?.attempted
            ? 'reserve'
            : previous?.attempted && !draft.attempted && !draft.receipt
              ? 'release'
              : undefined;
      return action
        ? [{ action, ...replyPublicationKey(draft.authorNodeId, draft.publication) }]
        : [];
    });
    return this.use(false, async (db) => {
      if (publications.length) await this.shared.attachForReply(db.$client);
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          // Selection, update deduplication and retirement all depend on the whole session.
          const ids = [...changed.map(({ id }) => id), ...removed];
          const scopeKey = eq(replyDrafts.scope, scope);
          const rows = tx
            .select()
            .from(replyDrafts)
            .where(checkSelection ? scopeKey : and(scopeKey, inArray(replyDrafts.id, ids)))
            .all();
          const expectedCount = checkSelection
            ? expected.size
            : ids.filter((id) => expected.has(id)).length;
          if (
            rows.length !== expectedCount ||
            rows.some(({ id, value }) => expected.get(id) !== JSON.stringify(value))
          )
            throw new Error('reply-draft-conflict');
          for (const { action, publisher, target } of publications) {
            if (action === 'release') {
              tx.run(
                sql`DELETE FROM installation.reply_publications WHERE publisher = ${publisher} AND target = ${target}`,
              );
            } else {
              const inserted =
                tx.run(sql`INSERT INTO installation.reply_publications (publisher, target)
                VALUES (${publisher}, ${target}) ON CONFLICT DO NOTHING`);
              if (action === 'reserve' && !inserted.changes)
                throw Object.assign(new Error(replyPublicationReserved), {
                  code: replyPublicationReserved,
                });
            }
          }
          for (const value of changed) {
            tx.insert(replyDrafts)
              .values({ scope, id: value.id, value })
              .onConflictDoUpdate({
                target: [replyDrafts.scope, replyDrafts.id],
                set: { value },
              })
              .run();
          }
          for (const id of removed)
            tx.delete(replyDrafts)
              .where(and(eq(replyDrafts.scope, scope), eq(replyDrafts.id, id)))
              .run();
        },
        { behavior: 'immediate' },
      );
    });
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
    expected: AgentRows['directEntries']['value'][],
  ) {
    return this.use(false, (db) =>
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          const key = and(eq(directEntries.scope, scope), eq(directEntries.kind, kind));
          const saved = tx.select().from(directEntries).where(key).all();
          // Another observer can confirm the very same archive while the native call returns.
          const completed = entries[0];
          if (
            kind === 'native-retirement' &&
            entries.length === 1 &&
            completed &&
            'archived' in completed &&
            completed.archived &&
            saved.length === 1 &&
            saved[0]?.id === completed.digest &&
            isDeepStrictEqual(saved[0].value, completed)
          )
            return;
          const snapshot = new Map(
            expected.map((value) => [
              'id' in value ? value.id : value.digest,
              JSON.stringify(value),
            ]),
          );
          if (
            saved.length !== snapshot.size ||
            saved.some(({ id, value }) => JSON.stringify(value) !== snapshot.get(id))
          )
            throw new Error(kind + '-entry-conflict');
          tx.delete(directEntries).where(key).run();
          for (const value of entries)
            tx.insert(directEntries)
              .values({ scope, kind, id: 'id' in value ? value.id : value.digest, value })
              .run();
        },
        { behavior: 'immediate' },
      ),
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
    return this.use(true, (db) => db.transaction((tx) => readIntake(tx, scope)));
  }

  changeIntake<T>(
    scope: string,
    resetOwner: boolean,
    change: (current?: IntakeState) => { state?: IntakeState; result: T },
  ) {
    return this.use(
      false,
      (db) =>
        db.transaction(
          (tx) => {
            assertPrivateStateLocksHeld();
            if (
              !resetOwner &&
              tx
                .select({ scope: notificationResets.scope })
                .from(notificationResets)
                .where(eq(notificationResets.scope, scope))
                .get()
            )
              throw Object.assign(new Error('notification-reset-in-progress'), {
                code: 'notification-reset-in-progress',
              });
            const { state, result } = change(readIntake(tx, scope));
            if (state) {
              const { records, ...header } = state;
              if (header.scope !== scope || records.some((record) => record.scope !== scope))
                throw new Error('intake record scope mismatch');
              tx.insert(intakeState)
                .values({ scope, value: header })
                .onConflictDoUpdate({ target: intakeState.scope, set: { value: header } })
                .run();
              saveJournalRows(tx, intakeRecords, scope, records);
            }
            return { result };
          },
          { behavior: 'immediate' },
        ).result,
    );
  }

  beginNotificationReset(
    record: AgentRows['notificationResets']['value'],
    expected: IntakeState | undefined,
  ) {
    return this.use(false, (db) =>
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          if (!isDeepStrictEqual(readIntake(tx, record.scope), expected))
            throw new Error('notification-reset-preview-changed');
          tx.insert(notificationResets).values({ scope: record.scope, value: record }).run();
        },
        { behavior: 'immediate' },
      ),
    );
  }

  readDispatch(scope: string) {
    return this.use(true, (db) => db.transaction((tx) => readDispatch(tx, scope)));
  }

  saveDispatch(scope: string, { records, ...value }: DispatchEnvelope, expected: DispatchEnvelope) {
    return this.use(false, (db) =>
      db.transaction(
        (tx) => {
          assertPrivateStateLocksHeld();
          const current = readDispatch(tx, scope) ?? {
            version: 4,
            scope: expected.scope,
            resetGeneration: 'initial',
            records: [],
          };
          if (current.resetGeneration !== expected.resetGeneration)
            throw new Error('notification-reset-stale-operation');
          if (!isDeepStrictEqual(normalizeDispatchPickup(current), expected))
            throw new Error(stateSnapshotConflictCode);
          tx.insert(dispatchState)
            .values({ scope, value })
            .onConflictDoUpdate({ target: dispatchState.scope, set: { value } })
            .run();
          saveJournalRows(tx, dispatchRecords, scope, records);
        },
        { behavior: 'immediate' },
      ),
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

  async attachForReply(client: DatabaseSync) {
    await this.checkDirectory();
    const url = pathToFileURL(this.path);
    url.searchParams.set('mode', 'rw');
    await this.withCheckedFile(false, false, () =>
      client.prepare('ATTACH DATABASE ? AS installation').run(url.href),
    );
  }

  async hasReplyPublication(key: InstallationRows['replyPublications']) {
    const rows = await this.read({ replyPublications: key });
    return rows.replyPublications.length > 0;
  }

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
    async (pending, client) => {
      if (pending.includes('20261125030731_reserve-reply-publications')) {
        client.exec(
          'CREATE TEMP TABLE prior_reply_publications (publisher TEXT, target TEXT, PRIMARY KEY (publisher, target))',
        );
        for await (const { agent } of sqliteAgentDatabases(installation))
          await agent.stageReplyMigration(client);
      }
      if (pending.some((name) => name.endsWith('_codex_schedule_ownership'))) {
        client.exec(
          'CREATE TEMP TABLE prior_automation_state(scope TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TEMP TABLE prior_automation_registrations(scope TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(scope,id))',
        );
        if (installation.migrateCodexSchedules)
          for await (const { agent, agentId } of sqliteAgentDatabases(installation))
            await agent.stageCodexSchedules(client, agentId);
      }
    },
  );
}

export function bindSqliteStorage(
  installation: SqliteInstallation,
  agentId: string,
  shared = bindSqliteInstallation(installation),
): BoundStorage &
  Record<keyof BoundStorage, StorageSchema & Pick<SqliteDatabase, 'exportSnapshot'>> {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(agentId)) throw new Error('invalid agent database name');
  return {
    agent: new SqliteAgentStore(installation, agentId, shared),
    installation: shared,
  };
}

export async function* sqliteAgentDatabases(
  installation: SqliteInstallation,
  shared = bindSqliteInstallation(installation),
) {
  const names = await readdir(installation.agentRoot).catch((error: unknown) => {
    if (nodeErrorCode(error) !== 'ENOENT') throw error;
    return [];
  });
  for (const name of names) {
    const match = /^([a-z0-9][a-z0-9-]*)\.sqlite$/u.exec(name);
    if (match) {
      const agentId = match[1]!;
      yield {
        agentId,
        agent: new SqliteAgentStore(installation, agentId, shared),
      };
    }
  }
}
