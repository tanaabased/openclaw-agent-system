import { bindAgentStore } from './storage/backend.ts';
import { sqliteDispatchPersistence } from './storage/dispatch-backend.ts';
import codexStorageLocation, {
  codexStorageBackend,
  codexPickupStore,
  retainedIntakeCandidates,
} from './storage/codex-storage.ts';
import { withDispatchTask } from './tasks/dispatch/dispatch-task-scope.ts';
import IssuePickupFailure from './issue-pickup-failure.ts';
import { omit } from 'lodash-es';
import reconcileIssuePickup from './issue-pickup-reconcile.ts';
import workflowFailure from './tasks/workflow-failure.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import issuePickupReport from './issue-pickup-report.ts';
import { codexHeartbeatEnvelope } from './codex-heartbeat.ts';
import codexCapacity, { codexItemOccupied } from './tasks/dispatch/codex-capacity.ts';
import {
  issuePickupAutomationId,
  issuePickupConfigurationCode,
} from './automations/issue-pickup-jobs.ts';
import issuePickup, { pickupAuthority, type PickupInput } from './issue-pickup.ts';
import type { IssuePickupClient } from '../channels/github/provider/issue-pickup-client.ts';
import { assertDispatchStorage } from './tasks/dispatch/dispatch-storage.ts';
import type { IssuePickupAuthority } from './issue-pickup-authority.ts';
import { connectCodexGitHub } from './codex-github-client.ts';
import {
  selectCodexTaskContext,
  type CodexTaskContextDependencies,
} from './tasks/context/codex-task-context.ts';
import acceptCodexIntakeOccurrence from './codex-intake-occurrence.ts';
import CodexDispatchStore from './tasks/dispatch/codex-dispatch-state.ts';
import { codexDispatchNative } from './tasks/dispatch/codex-dispatch-native.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import codexIssueNotice from './codex-issue-notice.ts';
import { CodexAutomationError } from './automations/automation-errors.ts';
import {
  inspectCodexDispatchActivation,
  inspectCodexPickupActivation,
} from './automations/codex-automation-activation.ts';
import { inspectCodexWorkspaceBinding } from './identity/codex-workspace-binding.ts';
import {
  type default as IntakeRecordStore,
  IntakeError,
  intakeLocation,
  intakeRemediation,
  type IntakeState,
} from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';

export interface CodexIntakeDependencies extends CodexTaskContextDependencies {
  issuePickup?: IssuePickupAuthority;
  pickupActivation?: (
    acceptedOccurrence: boolean,
  ) => Promise<{ threadId: string; nativeId: string }>;
  assertActive?: () => Promise<void>;
  threadId?: string;
  intakeNative?: Pick<ReturnType<typeof codexDispatchNative>, 'occurrence'>;
  now?: () => number;
  connect?: (workspace: string, signal: AbortSignal) => Promise<GitHubNotificationIntakeClient>;
}

async function retainedStore(pluginData: string, deps: CodexIntakeDependencies) {
  const requestedHome = resolve(
    deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  );
  const namespace = await realpath(requestedHome).catch(() => requestedHome);
  const binding = await (deps.inspectBinding ?? inspectCodexWorkspaceBinding)(pluginData);
  const matches: IntakeRecordStore[] = [];
  for await (const { store, agentId } of retainedIntakeCandidates(
    pluginData,
    deps.storageBackend,
  )) {
    const state = await store.read();
    if (
      !state ||
      (agentId !== undefined && state.agentId !== agentId) ||
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
      }).scope === store.location.scope
    )
      matches.push(store);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function connectSelected(
  current: Awaited<ReturnType<typeof selectCodexTaskContext>>,
  deps: CodexIntakeDependencies,
  signal: AbortSignal,
) {
  if (!current.policy) throw new IntakeError('intake-policy-disabled');
  const { policy, username } = current.policy;
  const client = await (deps.connect ?? connectCodexGitHub)(current.workspace, signal);
  await current.store.identities.resolve(policy, client, 'assignment');
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
  const current = await selectCodexTaskContext(pluginData, deps);
  const client = await connectSelected(current, deps, AbortSignal.timeout(30_000));
  const state = await current.store.read();
  if (state && !githubIdentityMatches(state.account, client.identity))
    throw new IntakeError('intake-account-changed');
  return { manifestDigest: current.digest };
}

async function assertCodexIntakeActive(
  pluginData: string,
  current: Awaited<ReturnType<typeof selectCodexTaskContext>>,
  deps: CodexIntakeDependencies,
) {
  try {
    if (deps.assertActive) await deps.assertActive();
    else
      await inspectCodexDispatchActivation(
        pluginData,
        current.automationBinding,
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
    const current = await selectCodexTaskContext(pluginData, deps);
    if (!current.policy) throw new IntakeError('intake-policy-disabled');
    const { policy, digest } = current.policy;
    if (!activate) {
      if (deps.assertActive) await deps.assertActive();
      else if (!deps.threadId) await assertCodexIntakeActive(pluginData, current, deps);
      else {
        const caller = deps.threadId;
        const activation = await inspectCodexDispatchActivation(
          pluginData,
          current.automationBinding,
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
          const journal = current.journal;
          await journal.observeIntake(async (state, save) =>
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
      const fresh = await selectCodexTaskContext(pluginData, deps);
      if (fresh.store.location.scope !== current.store.location.scope)
        throw new IntakeError('intake-workspace-binding-changed');
    };
    const result = await scanAssignments({
      runtime: 'codex',
      readIssuePickup: async () =>
        pickupAuthority((await current.journal.inspectIntake()).issuePickup) ?? deps.issuePickup,
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
        const live = await selectCodexTaskContext(pluginData, deps);
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
      return {
        status: 'busy',
        changed: false,
        ...workflowFailure(error, 'private-state-file-lock-busy'),
      };
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
        'automation-recovery-required',
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
  let journal: CodexDispatchStore | undefined;
  let context: { workspaceDir: string; scope: string } | undefined;
  try {
    const current = await selectCodexTaskContext(pluginData, deps);
    context = { workspaceDir: current.workspace, scope: current.store.location.scope };
    state = await current.store.read();
    journal = current.journal;
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
    if (state) {
      context = { workspaceDir: state.workspaceDir, scope: state.scope };
      const agent = await bindAgentStore(
        state.agentId,
        codexStorageLocation(pluginData),
        deps.storageBackend ?? codexStorageBackend(),
      );
      journal = new CodexDispatchStore(
        pluginData,
        state.scope,
        sqliteDispatchPersistence(agent, state.scope),
      );
    }
  }
  return {
    version: 1,
    status: code ? 'blocked' : 'ready',
    ...(code ? { code, remediation: intakeRemediation(code) } : {}),
    ...context,
    ...(journal ? { storage: (await journal.inspectIntake()).storage } : {}),
    baselineAt: state?.baselineAt ?? null,
    checkpoint: state?.checkpoint ?? null,
    blocker: state?.blocker ?? null,
    records: state?.records ?? [],
  };
}

/** internal enrollment consumer; activation and native model turns are wired by their scheduler owner. */
export async function runCodexIssuePickup(
  pluginData: string,
  input: PickupInput,
  timezone: string,
  deps: CodexIntakeDependencies = {},
) {
  let debug: boolean | undefined;
  let nativeOccurrence: { id: string; automationId: string } | undefined;
  try {
    const current = await selectCodexTaskContext(pluginData, deps);
    debug = current.manifest.debug;
    const enrollmentStore = await codexPickupStore(
      pluginData,
      current.agentId,
      deps.storageBackend,
    );
    const journal = current.journal;
    const verifyNative = async (policy: GitHubNotificationPolicy) => {
      const retained = await enrollmentStore.inspect(policy, 'codex', current.store.location.scope);
      if (!deps.threadId) throw new IntakeError('issue-pickup-native-caller-required');
      const connection = deps.intakeNative
        ? undefined
        : await connectCodexThreads(current.workspace, current.codexHome);
      try {
        const occurrence = await (
          deps.intakeNative ?? codexDispatchNative(connection!.request)
        ).occurrence(deps.threadId);
        const acceptedOccurrence = Boolean(
          (await journal.inspectIntake()).issuePickup?.operations.some(
            (entry) => entry.runId === occurrence.id,
          ),
        );
        const activation = deps.pickupActivation
          ? await deps.pickupActivation(acceptedOccurrence)
          : await inspectCodexPickupActivation(
              pluginData,
              current.automationBinding,
              acceptedOccurrence,
            );
        if (
          deps.threadId !== activation.threadId ||
          retained.nativeId !== activation.nativeId ||
          (nativeOccurrence && nativeOccurrence.id !== occurrence.id)
        )
          throw new IntakeError('issue-pickup-native-caller-required');
        if (occurrence.automationId !== activation.nativeId)
          throw new IntakeError('issue-pickup-native-caller-required');
        nativeOccurrence = occurrence;
      } finally {
        await connection?.close();
      }
      return retained;
    };
    let authority = deps.issuePickup;
    if (!authority) {
      if (!current.policy) throw new IntakeError('intake-policy-disabled');
      const retained = await verifyNative(current.policy.policy);
      authority = { enrollment: retained.enrollment, receipts: [] };
    }
    return await withDispatchTask('codex', undefined, () =>
      journal.exclusive(async (state, save, signal) => {
        const readPolicy = async () => {
          const live = await selectCodexTaskContext(pluginData, deps);
          if (live.store.location.scope !== current.store.location.scope || !live.policy)
            throw new IntakeError('intake-workspace-binding-changed');
          if (!deps.issuePickup) await verifyNative(live.policy.policy);
          return live.policy.policy;
        };
        await readPolicy();
        const client = (await connectSelected(current, deps, signal)) as IssuePickupClient;
        if (
          !client.discoverProject ||
          !client.projectCandidate ||
          !client.projectBlocked ||
          !client.assignProjectIssue
        )
          throw new IntakeError('issue-pickup-provider-unavailable');
        const result = await issuePickup({
          runtime: 'codex',
          scope: current.store.location.scope,
          workspaceDir: current.workspace,
          agentId: current.agentId,
          enrollment: authority.enrollment,
          timezone,
          state,
          save,
          assertWriteCapacity: () => {
            assertDispatchStorage(state, true);
          },
          now: deps.now ?? Date.now,
          readPolicy,
          client,
          instance: enrollmentStore.instance,
          runId: nativeOccurrence?.id ?? authority.enrollment.id,
          occupied: codexItemOccupied,
          input,
        });
        if (['material', 'selection-required', 'discovering'].includes(result.status))
          return {
            ...result,
            response: '',
            instructions:
              'instructions' in result
                ? result.instructions
                : result.status === 'discovering'
                  ? 'Call pickup again to continue discovery.'
                  : 'Follow next until the complete material is restored before selection.',
          };
        const reportPolicy = await readPolicy();
        const report = issuePickupReport({
          outcome: result,
          debug: current.manifest.debug,
          capacity: {
            occupied: codexCapacity(state, reportPolicy.maxConcurrentItems, state.issuePickup)
              .occupied,
            limit: reportPolicy.maxConcurrentItems,
          },
        });
        return {
          ...omit(result, ['selectionGuidance']),
          response: codexHeartbeatEnvelope(
            nativeOccurrence?.automationId ?? issuePickupAutomationId,
            report.response,
            report.notify,
          ),
          instructions:
            'instructions' in result
              ? result.instructions
              : 'Reproduce response unchanged as the whole final report. An empty response means no card. Preserve the native notification decision. Report preparation does not prove visible delivery.',
        };
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new IssuePickupFailure(error, { debug, automationId: nativeOccurrence?.automationId });
  }
}

/** explicit native automation preparation owns provider checks and the durable reservation. */
export async function prepareCodexPickupEnrollment(
  pluginData: string,
  deps: CodexIntakeDependencies = {},
) {
  const current = await selectCodexTaskContext(pluginData, deps);
  if (!current.policy) throw new IntakeError('intake-policy-disabled');
  const policy = current.policy.policy;
  const code = issuePickupConfigurationCode(policy);
  if (code) throw new IntakeError(code);
  const store = await codexPickupStore(pluginData, current.agentId, deps.storageBackend);
  await store.owner();
  const client = (await connectSelected(
    current,
    deps,
    AbortSignal.timeout(30_000),
  )) as IssuePickupClient;
  return current.journal.exclusive(async (state, save) =>
    store.prepare({
      policy,
      runtime: 'codex',
      scope: current.store.location.scope,
      workspaceDir: current.workspace,
      agentId: current.agentId,
      client,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      now: (deps.now ?? Date.now)(),
      reconcile: (record, commit) => reconcileIssuePickup(state, save, record, commit),
    }),
  );
}
