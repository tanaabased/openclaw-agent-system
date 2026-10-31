import { codexItemOccupied } from './codex-capacity.ts';
import projectPickup, { pickupAuthority, type PickupInput } from './project-pickup.ts';
import type { ProjectPickupClient } from '../channels/github/provider/project-pickup-client.ts';
import { dispatchStorageNotice } from './dispatch-storage.ts';
import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import type { ProjectPickupAuthority } from './project-pickup-authority.ts';
import connectCodexGitHubAccount from './codex-github-client.ts';
import { assertNotificationManagement } from './notification-reset-state.ts';
import acceptCodexIntakeOccurrence from './codex-intake-occurrence.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import codexIssueNotice from './codex-issue-notice.ts';
import { CodexAutomationError } from './codex-automation-state.ts';
import { codexIntakePolicy } from './codex-intake-policy.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import { inspectCodexWorkspaceBinding } from './codex-workspace-binding.ts';
import type { SetupProcessRunner } from './setup-runner.ts';
import IntakeRecordStore, {
  IntakeError,
  intakeLocation,
  intakeRemediation,
  type IntakeState,
} from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';

export interface CodexIntakeDependencies {
  projectPickup?: ProjectPickupAuthority;
  assertActive?: () => Promise<void>;
  threadId?: string;
  intakeNative?: Pick<ReturnType<typeof codexDispatchNative>, 'occurrence'>;
  codexHome?: string;
  now?: () => number;
  inspectBinding?: typeof inspectCodexWorkspaceBinding;
  connect?: (workspace: string, signal: AbortSignal) => Promise<GitHubNotificationIntakeClient>;
}

export async function connectCodexGitHub(
  workspace: string,
  signal: AbortSignal,
  run?: SetupProcessRunner,
) {
  return (await connectCodexGitHubAccount(workspace, signal, run)).client;
}

export async function selectCodexIntake(
  pluginData: string,
  deps: CodexIntakeDependencies,
  options: { resolvePolicy?: boolean; inspectionOnly?: boolean } = {},
) {
  const inspection = await (deps.inspectBinding ?? inspectCodexWorkspaceBinding)(pluginData);
  if (inspection.status !== 'bound') throw new IntakeError('intake-binding-unavailable');
  if (inspection.preview.status !== 'ready' || inspection.preview.manifest.status !== 'loaded')
    throw new IntakeError('intake-manifest-unavailable');
  const loaded = inspection.preview.manifest;
  const workspace = inspection.preview.workspaceDir;
  const policy = options.resolvePolicy === false ? undefined : codexIntakePolicy(loaded.manifest);
  const requestedHome = resolve(
    deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  );
  const namespace = await realpath(requestedHome).catch(() => requestedHome);
  const store = new IntakeRecordStore(
    intakeLocation({
      runtime: 'codex',
      root: pluginData,
      namespace,
      workspaceDir: workspace,
      agentId: loaded.manifest.agent.id,
    }),
  );
  await new GitHubIdentityCache(store.location).hydrate(loaded.manifest.github?.notifications);
  if (!options.inspectionOnly) await assertNotificationManagement(pluginData, store.location.scope);
  return {
    policy,
    store,
    workspace,
    agentId: loaded.manifest.agent.id,
    digest: loaded.digest,
    manifest: loaded.manifest,
    manifestPath: loaded.path,
    manifestSources: loaded.sources,
    codexHome: namespace,
  };
}

async function retainedStore(pluginData: string, deps: CodexIntakeDependencies) {
  const requestedHome = resolve(
    deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  );
  const namespace = await realpath(requestedHome).catch(() => requestedHome);
  const binding = await (deps.inspectBinding ?? inspectCodexWorkspaceBinding)(pluginData);
  const names = await readdir(pluginData).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  if (names.length > 2000) throw new IntakeError('intake-state-invalid');
  const matches: IntakeRecordStore[] = [];
  for (const name of names.filter((name) => /^github-intake-[a-f0-9]{64}\.json$/u.test(name))) {
    const scope = name.slice('github-intake-'.length, -'.json'.length);
    const store = new IntakeRecordStore({
      root: resolve(pluginData),
      path: join(resolve(pluginData), name),
      scope,
    });
    const state = await store.read();
    if (
      !state ||
      (binding.status === 'bound' && state.workspaceDir !== binding.binding.workspaceDir)
    )
      continue;
    if (
      intakeLocation({
        runtime: 'codex',
        root: pluginData,
        namespace,
        workspaceDir: state.workspaceDir,
        agentId: state.agentId,
      }).scope === scope
    )
      matches.push(store);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function connectSelected(
  current: Awaited<ReturnType<typeof selectCodexIntake>>,
  deps: CodexIntakeDependencies,
  signal: AbortSignal,
) {
  if (!current.policy) throw new IntakeError('intake-policy-disabled');
  const { policy, username } = current.policy;
  const client = await (deps.connect ?? connectCodexGitHub)(current.workspace, signal);
  await new GitHubIdentityCache(current.store.location).resolve(policy, client, 'assignment');
  const pin = policy.issueAssignment?.allowed.find(
    (actor) => actor.login.toLowerCase() === username.toLowerCase(),
  );
  if (
    client.identity.login.toLowerCase() !== username.toLowerCase() ||
    (pin && pin.nodeId !== client.identity.nodeId)
  )
    throw new IntakeError('intake-github-identity-mismatch');
  return client;
}

/** authorized install verifies native identity before it prepares an active schedule write. */
export async function preflightCodexIntake(pluginData: string, deps: CodexIntakeDependencies = {}) {
  const current = await selectCodexIntake(pluginData, deps);
  const client = await connectSelected(current, deps, AbortSignal.timeout(30_000));
  const state = await current.store.read();
  if (state && !githubIdentityMatches(state.account, client.identity))
    throw new IntakeError('intake-account-changed');
  return { manifestDigest: current.digest };
}

async function assertCodexIntakeActive(
  pluginData: string,
  current: Awaited<ReturnType<typeof selectCodexIntake>>,
  deps: CodexIntakeDependencies,
) {
  try {
    if (deps.assertActive) await deps.assertActive();
    else
      await inspectCodexDispatchActivation(
        pluginData,
        { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
        false,
        false,
        'intake',
      );
  } catch (error) {
    if (error instanceof CodexAutomationError) throw new IntakeError(error.code);
    throw error;
  }
}

export async function runCodexIntake(
  pluginData: string,
  activate = false,
  deps: CodexIntakeDependencies = {},
) {
  try {
    const current = await selectCodexIntake(pluginData, deps);
    if (!current.policy) throw new IntakeError('intake-policy-disabled');
    const { policy, digest } = current.policy;
    if (!activate) {
      if (deps.assertActive) await deps.assertActive();
      else if (!deps.threadId) await assertCodexIntakeActive(pluginData, current, deps);
      else {
        const caller = deps.threadId;
        const activation = await inspectCodexDispatchActivation(
          pluginData,
          { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
          false,
          true,
          'intake',
        );
        if (caller !== activation.sourceThreadId)
          throw new IntakeError('dispatch-intake-caller-required');
        const connection = deps.intakeNative
          ? undefined
          : await connectCodexThreads(current.workspace, current.codexHome);
        try {
          const occurrence = await (
            deps.intakeNative ?? codexDispatchNative(connection!.request)
          ).occurrence(caller);
          const journal = new CodexDispatchStore(
            current.store.location.root,
            current.store.location.scope,
          );
          await journal.exclusive(async (state, save) =>
            acceptCodexIntakeOccurrence(
              state,
              occurrence,
              () => assertCodexIntakeActive(pluginData, current, deps),
              save,
            ),
          );
        } finally {
          await connection?.close();
        }
      }
    }
    const assertCurrent = async () => {
      const fresh = await selectCodexIntake(pluginData, deps);
      if (fresh.store.location.scope !== current.store.location.scope)
        throw new IntakeError('intake-workspace-binding-changed');
    };
    const result = await scanAssignments({
      runtime: 'codex',
      readProjectPickup: async () =>
        pickupAuthority(
          (
            await new CodexDispatchStore(
              current.store.location.root,
              current.store.location.scope,
            ).read()
          ).projectPickup,
        ) ?? deps.projectPickup,
      store: current.store,
      workspaceDir: current.workspace,
      agentId: current.agentId,
      policy,
      policyDigest: digest,
      now: (deps.now ?? Date.now)(),
      activate,
      async connect(signal) {
        await assertCurrent();
        return connectSelected(
          current,
          deps,
          AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        );
      },
      assertCurrent,
      async readPolicy() {
        await assertCurrent();
        const live = await selectCodexIntake(pluginData, deps);
        if (!live.policy) throw new IntakeError('intake-policy-disabled');
        return live.policy;
      },
    });
    return {
      ...result,
      ...(result.status === 'blocked'
        ? {
            notice: codexIssueNotice({
              event: 'failure',
              changed: result.changed,
              code: 'code' in result ? result.code : undefined,
            }),
          }
        : 'recovered' in result && result.recovered
          ? { notice: codexIssueNotice({ event: 'intake-recovered', changed: true }) }
          : {}),
    };
  } catch (error) {
    if (
      !activate &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'private-state-file-lock-busy'
    )
      return { status: 'busy', changed: false };
    // a revoked policy cannot admit work, but its retained evidence can suppress repeated notices.
    if (
      activate ||
      !(error instanceof IntakeError) ||
      ![
        'intake-binding-unavailable',
        'intake-manifest-unavailable',
        'intake-policy-disabled',
        'intake-policy-reconciliation-required',
        'intake-automation-paused',
        'intake-automation-update-required',
        'intake-activation-required',
      ].includes(error.code)
    )
      throw error;
    const store = await retainedStore(pluginData, deps);
    if (!store) throw error;
    return store.exclusive(async (state, save) => {
      if (!state) throw error;
      const now = (deps.now ?? Date.now)();
      const changed = state.blocker?.code !== error.code;
      const result = { status: 'blocked', code: error.code, changed };
      const next = {
        ...state,
        lastAttemptAt: now,
        blocker: {
          code: error.code,
          since: changed ? now : state.blocker!.since,
          retryAfter: now,
        },
      };
      await save(next);
      return {
        ...result,
        notice: codexIssueNotice({ event: 'failure', code: error.code, changed: result.changed }),
      };
    });
  }
}

/** inspection neither authenticates nor changes state, and never starts a scan. */
export async function inspectCodexIntake(pluginData: string, deps: CodexIntakeDependencies = {}) {
  let state: IntakeState | undefined;
  let code: string | undefined;
  let context: { workspaceDir: string; scope: string } | undefined;
  try {
    const current = await selectCodexIntake(pluginData, deps);
    context = { workspaceDir: current.workspace, scope: current.store.location.scope };
    state = await current.store.read();
    code = !current.policy
      ? 'intake-policy-disabled'
      : !state
        ? 'intake-activation-required'
        : state.blocker?.code;
    if (current.policy && state) await assertCodexIntakeActive(pluginData, current, deps);
  } catch (error) {
    state = await retainedStore(pluginData, deps)
      .then((store) => store?.read())
      .catch(() => undefined);
    code = error instanceof IntakeError ? error.code : 'intake-inspection-failed';
    if (state) context = { workspaceDir: state.workspaceDir, scope: state.scope };
  }
  return {
    version: 1,
    status: code ? 'blocked' : 'ready',
    ...(code ? { code, remediation: intakeRemediation(code) } : {}),
    ...context,
    ...(context
      ? {
          storage: dispatchStorageNotice(
            await new CodexDispatchStore(pluginData, context.scope).read(),
          ),
        }
      : {}),
    baselineAt: state?.baselineAt ?? null,
    checkpoint: state?.checkpoint ?? null,
    blocker: state?.blocker ?? null,
    records: state?.records ?? [],
  };
}

/** internal enrollment consumer; activation and native model turns are wired by their scheduler owner. */
export async function runCodexProjectPickup(
  pluginData: string,
  input: PickupInput,
  timezone: string,
  deps: CodexIntakeDependencies = {},
) {
  if (!deps.projectPickup) throw new IntakeError('project-pickup-activation-required');
  const current = await selectCodexIntake(pluginData, deps);
  await assertCodexIntakeActive(pluginData, current, deps);
  const journal = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  return journal.exclusive(async (state, save, signal) => {
    const readPolicy = async () => {
      const live = await selectCodexIntake(pluginData, deps);
      if (live.store.location.scope !== current.store.location.scope || !live.policy)
        throw new IntakeError('intake-workspace-binding-changed');
      return live.policy.policy;
    };
    await readPolicy();
    const client = (await connectSelected(current, deps, signal)) as ProjectPickupClient;
    if (
      !client.discoverProject ||
      !client.projectCandidate ||
      !client.projectBlocked ||
      !client.assignProjectIssue
    )
      throw new IntakeError('project-pickup-provider-unavailable');
    return projectPickup({
      runtime: 'codex',
      scope: current.store.location.scope,
      workspaceDir: current.workspace,
      agentId: current.agentId,
      enrollment: deps.projectPickup!.enrollment,
      timezone,
      state,
      save,
      now: deps.now ?? Date.now,
      readPolicy,
      client,
      occupied: codexItemOccupied,
      input,
    });
  });
}
