import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
// Temporary, operator-run importer for #792. Run from the source checkout with Node.
import { normalizeDispatchPickup } from '../agent/tasks/dispatch/dispatch-state.ts';
import { pickupDispatchScope } from '../agent/storage/dispatch-backend.ts';
import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { Value } from 'typebox/value';
import type { Static, TSchema } from 'typebox';

import { automationHash } from '../agent/automation-hash.ts';
import AutomationReportStore, { reportRow } from '../agent/automations/automation-report-store.ts';
import AutomationStore from '../agent/automations/automation-store.ts';
import { ledgerSchema as threadsSchema } from '../agent/automations/automation-threads.ts';
import { ledgerSchema as codexAutomations } from '../agent/automations/codex-automation-snapshot.ts';
import { stateSchema as sidebarSchema } from '../agent/codex-sidebar-journal.ts';
import {
  inspectCodexWorkspaceBinding,
  previewCodexWorkspace,
} from '../agent/identity/codex-workspace-binding.ts';
import IssuePickupEnrollmentStore from '../agent/issue-pickup-enrollment.ts';
import NotificationResetStore from '../agent/notification-reset-state.ts';
import { bindSqliteStorage } from '../agent/storage/agent-database.ts';
import type {
  AgentRows,
  InstallationRows,
  RecordChange,
  Selection,
  WorkflowRecords,
} from '../agent/storage/workflow-records.ts';
import AssignmentClaimStore from '../agent/tasks/dispatch/assignment-claim-store.ts';
import CodexDispatchStore from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import OpenClawDispatchStore from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import { draftSchema } from '../agent/tasks/feedback/reply-store.ts';
import { implementationEntriesSchema } from '../agent/tasks/implementation/implementation-entry-state.ts';
import { entriesSchema as retirementEntries } from '../agent/tasks/retirement/native-retirement.ts';
import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import IntakeRecordStore, {
  intakeLocation,
  intakeScopeLocation,
} from '../channels/github/intake/record-store.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import { resolveFileCredentialStoreRoot } from '../credentials/file-store.ts';
import PathProjectionStore from '../paths/projection-store.ts';
import { parseRepositoryRecord } from '../tools/git/repository-service.ts';
import resolveGitWorktreeLayout from '../tools/git/worktree-layout.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';

async function names(directory: string) {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function contents(path: string) {
  const raw = await new PrivateStateFile({
    directories: [dirname(path)],
    path,
    currentUid: process.getuid?.(),
    label: 'legacy workflow state',
    maximumBytes: 8 * 1024 * 1024,
  }).read();
  if (raw === undefined) throw new Error('source disappeared during import: ' + path);
  return raw;
}

function checked<S extends TSchema>(schema: S, value: unknown, path: string): Static<S> {
  if (!Value.Check(schema, value)) throw new Error('invalid legacy record: ' + path);
  return value;
}

function rowKey(row: object) {
  if ('executionId' in row) return JSON.stringify(row.executionId);
  return JSON.stringify(
    Object.entries(row)
      .filter(([key]) => key !== 'value')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

class ImportPlan<Rows extends Record<string, object>> {
  private readonly tables = new Map<keyof Rows, Map<string, Rows[keyof Rows]>>();

  add<Name extends keyof Rows>(table: Name, row: Rows[Name]) {
    const rows = this.tables.get(table) ?? new Map();
    const key = rowKey(row);
    if (rows.has(key)) throw new Error('duplicate source record in ' + String(table));
    rows.set(key, row);
    this.tables.set(table, rows);
  }

  async prepare(storage?: WorkflowRecords<Rows>) {
    const changes: RecordChange<Rows>[] = [];
    const counts: Record<string, { insert: number; present: number }> = {};
    const query = Object.fromEntries(
      [...this.tables.keys()].map((table) => [table, {}]),
    ) as Selection<Rows>;
    const existing = await storage?.read(query);
    for (const [table, rows] of this.tables) {
      const found = new Map((existing?.[table] ?? []).map((row) => [rowKey(row), row]));
      if (table === 'instances' && [...found.keys()].some((key) => !rows.has(key)))
        throw new Error(
          'SQLite already contains a different instance identity. Import into the shared database before initializing a new instance.',
        );
      const count = (counts[String(table)] = { insert: 0, present: 0 });
      for (const [key, row] of rows) {
        const previous = found.get(key);
        if (previous) {
          const comparable =
            table === 'dispatchState' && 'value' in previous
              ? { ...previous, value: normalizeDispatchPickup(previous.value) }
              : previous;
          if (!isDeepStrictEqual(comparable, row))
            throw new Error('destination differs in ' + String(table) + ' ' + key);
          count.present++;
        } else {
          changes.push({ table, action: 'insert', row });
          count.insert++;
        }
      }
    }
    return { changes, counts };
  }
}

export interface ImportOptions {
  runtime: 'codex' | 'openclaw';
  agentId: string;
  workspace: string;
  profile: string;
  stateRoot: string;
  privateRoot: string;
  repositories: string[];
  sessionScopes: string[];
  apply: boolean;
}

export async function importAgentStorage(options: ImportOptions) {
  const { runtime, agentId, workspace, profile, stateRoot, privateRoot } = options;
  const codex = runtime === 'codex';
  // Gateway intake and session scopes retain the configured path, even through a symlink.
  const namespace = codex ? profile : stateRoot;
  const agentRoot = join(stateRoot, 'agent-system-storage');
  const installationRoot = codex
    ? join(stateRoot, 'instance')
    : join(privateRoot, 'agent-system-instance');
  const intakeRoot = codex ? stateRoot : join(privateRoot, 'agent-system-intake-v2');
  const dispatchRoot = codex ? stateRoot : join(privateRoot, 'agent-system-dispatch-v2');
  const automationRoot = codex ? stateRoot : join(stateRoot, 'agent-system-automations');
  const installation = {
    agentRoot,
    installationRoot,
    schemaRoot: resolve(import.meta.dirname, '../agent/storage'),
  };
  const storage = bindSqliteStorage(installation, agentId);
  for (const store of [storage.agent, storage.installation]) {
    const finding = await store.inspect();
    if (finding.status !== 'healthy')
      throw new Error(finding.message + ' — run Agent System install first');
  }
  const agent = new ImportPlan<AgentRows>();
  const shared = new ImportPlan<InstallationRows>();
  const auto = new AutomationStore({
    root: automationRoot,
    agentId,
    workspaceDir: workspace,
    profile,
  });
  const autoScope = codex
    ? automationHash({ runtime, profile, agentId, workspaceDir: workspace })
    : auto.scope;
  const autoFiles = await names(automationRoot);
  const dispatchFiles = await names(dispatchRoot);
  const unattributed = new Set<string>();
  const attributed = new Map<string, string>();
  const scopes = new Map([[autoScope, { agentId, workspace }]]);
  const retainedPlans = new Map<string, ImportPlan<AgentRows>>();
  const enrollments = await new IssuePickupEnrollmentStore(installationRoot).read();
  async function collectWorkspace(
    agentId: string,
    workspace: string,
    agent: ImportPlan<AgentRows>,
    selectedSessions: string[],
  ) {
    const location = intakeLocation({
      runtime,
      agentId,
      root: intakeRoot,
      workspaceDir: workspace,
      namespace,
    });
    const { scope } = location;
    const intake = await new IntakeRecordStore(location).read();
    if (intake) {
      const { records, ...value } = intake;
      if (value.agentId !== agentId || value.workspaceDir !== workspace)
        throw new Error('intake owner mismatch');
      agent.add('intakeState', { scope, value });
      for (const record of records)
        agent.add('intakeRecords', { scope, id: record.id, value: record });
    }
    const pins = await new GitHubIdentityCache(location).read();
    for (const [id, value] of Object.entries(pins.entries))
      agent.add('githubIdentityPins', { scope, id, value });
    const reset = await new NotificationResetStore(dispatchRoot, scope).read();
    if (reset) {
      if (reset.agentId !== agentId || reset.runtime !== runtime || reset.workspace !== workspace)
        throw new Error('reset owner mismatch');
      agent.add('notificationResets', { scope, value: reset });
    }
    const sessions = new Set(selectedSessions);

    const journalName = runtime + '-dispatch-' + scope + '.json';
    const journals = [{ root: dispatchRoot, key: scope, files: dispatchFiles }];
    if (!codex)
      journals.push({
        root: intakeRoot,
        key: pickupDispatchScope(scope),
        files: await names(intakeRoot),
      });
    for (const { root, key, files } of journals) {
      if (!files.includes(journalName)) continue;
      const store = codex
        ? new CodexDispatchStore(root, scope)
        : new OpenClawDispatchStore(root, scope);
      const { records, ...value } = await store.readEnvelope();
      agent.add('dispatchState', { scope: key, value });
      for (const record of records) {
        if (!record || typeof record.id !== 'string' || !record.id)
          throw new Error('dispatch record missing id');
        agent.add('dispatchRecords', { scope: key, id: record.id, value: record });
        const session = record.threadId;
        const incarnation = codex
          ? session
          : 'sessionCreation' in record && record.sessionCreation?.sessionId;
        if (typeof session === 'string' && typeof incarnation === 'string') {
          sessions.add(
            automationHash({
              runtime,
              agentId,
              workspace,
              namespace,
              session,
              incarnation,
            }),
          );
        }
      }
    }

    for (const name of dispatchFiles) {
      const match =
        /^github-(reply|implementation|native-retirement)-([a-f0-9]{64})(?:-([a-f0-9]{64}))?\.json$/u.exec(
          name,
        );
      if (!match) continue;
      const [, kind, sessionScope, draftId] = match;
      if (!sessions.has(sessionScope!)) {
        unattributed.add(sessionScope!);
        continue;
      }
      const previousOwner = attributed.get(sessionScope!);
      if (previousOwner && previousOwner !== agentId)
        throw new Error('session scope selected for two agents: ' + sessionScope);
      attributed.set(sessionScope!, agentId);
      const path = join(dispatchRoot, name);
      const raw = JSON.parse(await contents(path));
      if (kind === 'reply') {
        const draft = checked(draftSchema, raw, path);
        if (draft.id !== draftId) throw new Error('reply draft id mismatch: ' + path);
        agent.add('replyDrafts', { scope: sessionScope!, id: draft.id, value: draft });
      } else {
        if (draftId || raw?.scope !== sessionScope)
          throw new Error('entry scope mismatch: ' + path);
        if (kind === 'implementation') {
          for (const value of checked(implementationEntriesSchema, raw.entries, path))
            agent.add('directEntries', { scope: sessionScope!, kind, id: value.id, value });
        } else {
          for (const value of checked(retirementEntries, raw.entries, path))
            agent.add('directEntries', {
              scope: sessionScope!,
              kind: 'native-retirement',
              id: value.digest,
              value,
            });
        }
      }
    }

    for (const value of enrollments.records) {
      const owner = value.enrollment;
      if (
        owner.runtime === runtime &&
        owner.agentId === agentId &&
        owner.workspaceDir === workspace &&
        owner.scope === scope
      )
        agent.add('pickupEnrollments', { runtime, scope: owner.scope, value });
    }
  }
  if (codex) {
    // Codex can recover intake from an earlier binding even when it has no automation ledger.
    for (const name of dispatchFiles) {
      const match = /^github-intake-([a-f0-9]{64})\.json$/u.exec(name);
      if (!match) continue;
      const store = new IntakeRecordStore(intakeScopeLocation(stateRoot, match[1]!));
      const state = await store.read();
      if (!state) continue;
      const owner = { agentId: state.agentId, workspace: state.workspaceDir };
      if (
        intakeLocation({
          runtime,
          root: intakeRoot,
          agentId: owner.agentId,
          workspaceDir: owner.workspace,
          namespace: profile,
        }).scope === store.location.scope
      )
        scopes.set(
          automationHash({
            runtime,
            profile,
            agentId: owner.agentId,
            workspaceDir: owner.workspace,
          }),
          owner,
        );
    }
    for (const name of autoFiles) {
      const match = /^codex-automations-([a-f0-9]{64})\.json$/u.exec(name);
      if (!match || match[1] === autoScope) continue;
      const path = join(automationRoot, name);
      const raw = JSON.parse(await contents(path));
      const binding = raw?.binding;
      if (!binding || binding.codexHome !== profile) continue;
      const ledger = checked(codexAutomations, raw, path);
      const expected = automationHash({
        runtime,
        profile,
        agentId: binding.agentId,
        workspaceDir: binding.workspace,
      });
      if (ledger.scope !== match[1] || expected !== match[1])
        throw new Error('automation owner mismatch: ' + path);
      scopes.set(ledger.scope, { agentId: binding.agentId, workspace: binding.workspace });
    }
  }
  for (const [ledgerScope, owner] of scopes) {
    const plan =
      owner.agentId === agentId
        ? agent
        : (retainedPlans.get(owner.agentId) ?? new ImportPlan<AgentRows>());
    if (owner.agentId !== agentId) retainedPlans.set(owner.agentId, plan);
    await collectWorkspace(
      owner.agentId,
      owner.workspace,
      plan,
      ledgerScope === autoScope ? options.sessionScopes : [],
    );
    const ledgerName = (codex ? 'codex-automations-' : 'automations-') + ledgerScope + '.json';
    if (autoFiles.includes(ledgerName)) {
      const path = join(automationRoot, ledgerName);
      const { records, ...value } = codex
        ? checked(codexAutomations, JSON.parse(await contents(path)), path)
        : await auto.read();
      if (
        value.scope !== ledgerScope ||
        ('binding' in value &&
          value.binding &&
          (value.binding.agentId !== owner.agentId ||
            value.binding.workspace !== owner.workspace ||
            value.binding.codexHome !== profile))
      )
        throw new Error('automation owner mismatch');
      plan.add('automationState', { scope: ledgerScope, value });
      for (const record of records)
        plan.add('automationRegistrations', { scope: ledgerScope, id: record.id, value: record });
    }
    const threads = 'automation-threads-' + ledgerScope + '.json';
    if (autoFiles.includes(threads)) {
      const path = join(automationRoot, threads);
      const ledger = checked(threadsSchema, JSON.parse(await contents(path)), path);
      if (ledger.scope !== ledgerScope) throw new Error('thread scope mismatch');
      for (const value of ledger.records)
        plan.add('automationThreads', { scope: ledgerScope, id: value.key, value });
    }
  }
  if (!codex) {
    const reports = new AutomationReportStore(join(automationRoot, 'reports'));
    for (const executionId of await reports.ids()) {
      const value = await reports.read(executionId);
      if (value?.target.agentId === agentId && value.target.workspaceDir === workspace)
        agent.add('automationReports', reportRow(value));
    }
    const projection = await new PathProjectionStore({
      storageBackend: 'file',
      rootDir: privateRoot,
      currentUid: process.getuid?.(),
    }).read(agentId);
    if (projection && projection.workspaceDir === workspace)
      agent.add('pathProjections', { scope: workspace, value: projection });
  } else {
    for (const name of dispatchFiles) {
      const match = /^codex-sidebar-([a-f0-9]{64})\.json$/u.exec(name);
      if (!match) continue;
      const path = join(stateRoot, name);
      const value = checked(sidebarSchema, JSON.parse(await contents(path)), path);
      if (automationHash({ profile, host: 'local', name: value.name }) === match[1])
        shared.add('sidebarPlacements', { scope: match[1], value });
    }
  }
  const instance = await new AssignmentClaimStore(installationRoot).read();
  if (instance) {
    const { claims, ...value } = instance;
    shared.add('instances', { id: value.instanceId, value });
    for (const [id, claim] of Object.entries(claims))
      shared.add('assignmentClaims', { id, value: claim });
  }
  for (const root of new Set(options.repositories)) {
    for (const name of await names(root)) {
      if (!name.endsWith('.repository.json')) continue;
      const value = parseRepositoryRecord(await contents(join(root, name)));
      if (name !== gitWorktreeRepositoryDirectoryName(value.repositoryId) + '.repository.json')
        throw new Error('repository filename mismatch: ' + name);
      shared.add('managedRepositories', { root, id: value.repositoryId, value });
    }
  }
  const agentPlan = await agent.prepare(storage.agent);
  const retained = await Promise.all(
    [...retainedPlans].map(async ([id, plan]) => {
      const target = bindSqliteStorage(installation, id).agent;
      const finding = await target.inspect();
      const missing = finding.code === 'agent-storage-missing';
      if (!missing && finding.status !== 'healthy') throw new Error(finding.message);
      const prepared = await plan.prepare(missing ? undefined : target);
      return { id, target, missing, plan, ...prepared };
    }),
  );
  let sharedPlan = await shared.prepare(storage.installation);
  if (options.apply) {
    // Serialize the singleton identity check and insert with setup and other agent imports.
    const lock = await acquirePrivateStateFileLock(
      join(installationRoot, 'assignment-claims.json'),
      {
        staleMs: 30_000,
        retries: { retries: 40, factor: 1, minTimeout: 25, maxTimeout: 25 },
      },
    );
    try {
      await withPrivateStateLock(lock, async () => {
        sharedPlan = await shared.prepare(storage.installation);
        await storage.installation.write(sharedPlan.changes);
      });
    } finally {
      await lock.release();
    }
    await storage.agent.write(agentPlan.changes);
    for (const previous of retained) {
      if (previous.missing) await previous.target.install();
      await previous.target.write((await previous.plan.prepare(previous.target)).changes);
    }
  }
  return {
    mode: options.apply ? 'applied' : 'preview',
    agent: join(agentRoot, agentId + '.sqlite'),
    shared: join(installationRoot, 'agent-system.sqlite'),
    agentRows: agentPlan.counts,
    sharedRows: sharedPlan.counts,
    unselectedSessionScopes: [...unattributed].filter((scope) => !attributed.has(scope)),
    workspaces: [...scopes.values()],
    retainedAgentRows: Object.fromEntries(
      retained.map((previous) => [previous.id, previous.counts]),
    ),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      runtime: { type: 'string', default: 'codex' },
      'state-root': { type: 'string' },
      'private-root': { type: 'string' },
      workspace: { type: 'string' },
      profile: { type: 'string' },
      'session-scope': { type: 'string', multiple: true },
      'repository-root': { type: 'string', multiple: true },
      apply: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'node --import tsx scripts/import-agent-storage.ts --state-root PATH [--apply]\nCodex uses its bound workspace. For OpenClaw add --runtime openclaw --workspace PATH and use the Gateway state directory as --state-root. --private-root overrides the Gateway private state root. --profile overrides CODEX_HOME. Add --repository-root for additional managed roots. --session-scope selects an otherwise unattributed chat hash for this agent. Preview first. Stop JSON writers during apply. The source files are preserved.\n',
    );
    return;
  }
  const runtime = values.runtime;
  if (runtime !== 'codex' && runtime !== 'openclaw') throw new Error('select codex or openclaw');
  if (!values['state-root']) throw new Error('--state-root is required');
  const stateRoot =
    runtime === 'codex' ? await realpath(values['state-root']) : resolve(values['state-root']);
  let preview;
  if (runtime === 'codex') {
    const binding = await inspectCodexWorkspaceBinding(stateRoot);
    if (binding.status !== 'bound') throw new Error('Codex workspace binding required');
    preview = binding.preview;
    if (values.workspace || values['private-root'])
      throw new Error('--workspace and --private-root apply to OpenClaw');
  } else {
    if (!values.workspace || values.profile)
      throw new Error('OpenClaw requires --workspace and takes its profile from --state-root');
    preview = await previewCodexWorkspace(values.workspace);
  }
  if (preview.status !== 'ready' || preview.manifest.status !== 'loaded')
    throw new Error('workspace manifest unavailable');
  const workspace = preview.workspaceDir;
  const manifest = preview.manifest.manifest;
  const layout = resolveGitWorktreeLayout(workspace, manifest.git?.worktrees ?? {});
  const profile =
    runtime === 'codex'
      ? await realpath(values.profile ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'))
      : await realpath(stateRoot);
  const result = await importAgentStorage({
    runtime,
    profile,
    workspace,
    agentId: manifest.agent.id,
    stateRoot,
    privateRoot: resolve(
      values['private-root'] ?? resolveFileCredentialStoreRoot(process.env) ?? stateRoot,
    ),
    repositories: [
      layout.repositoryRoot,
      ...(values['repository-root'] ?? []).map((path) => resolve(path)),
    ],
    sessionScopes: values['session-scope'] ?? [],
    apply: !!values.apply,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (import.meta.main)
  main().catch((error: Error) => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
