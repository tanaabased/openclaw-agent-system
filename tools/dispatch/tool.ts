import workflowFailure, { workflowFailureScope } from '../../agent/workflow-failure.ts';
import codexIssueNotice from '../../agent/codex-issue-notice.ts';
import { dispatchFailurePhase } from '../../agent/dispatch-retry.ts';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { Value } from 'typebox/value';

import AutomationThreads, { automationThreadSelection } from '../../agent/automation-threads.ts';
import type AutomationService from '../../agent/automation-service.ts';
import openclawIntakeJobs, {
  openclawIntakeAutomationId,
} from '../../agent/openclaw-intake-policy.ts';
import OpenClawDispatch, {
  openClawDispatchFailureCode,
  type OpenClawDispatchDependencies,
} from '../../agent/openclaw-dispatch.ts';
import type { DispatchCaller } from '../../agent/openclaw-session-create.ts';
import type OpenClawIntake from '../../agent/openclaw-intake.ts';
import type { RegisteredAgentSystemTool } from '../../api/types.ts';
import AgentSystemToolError from '../../api/error.ts';
import type AgentManifestService from '../../manifest/service.ts';
import type TrustedGitWorktreeService from '../git/trusted-worktree-service.ts';
import { dispatchParameters } from './tool-schema.ts';

interface NativeContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
}
function caller(
  context: NativeContext,
  event: Pick<NativeContext, 'runId' | 'toolCallId'>,
  session: { sessionId: string; archivedAt?: number } | undefined,
): DispatchCaller {
  const runId = event.runId ?? context.runId;
  const toolCallId = event.toolCallId ?? context.toolCallId;
  const sessionId = context.sessionId ?? session?.sessionId;
  if (
    (event.runId && context.runId && event.runId !== context.runId) ||
    (event.toolCallId && context.toolCallId && event.toolCallId !== context.toolCallId)
  )
    throw new Error('dispatch-native-caller-conflict');
  if (!context.agentId || !context.sessionKey || !sessionId || !runId || !toolCallId)
    throw new Error(
      `dispatch-native-caller-unavailable: agentId=${!!context.agentId}; sessionKey=${!!context.sessionKey}; sessionId=${!!sessionId}; runId=${!!runId}; toolCallId=${!!toolCallId}`,
    );
  if (!session || session.archivedAt || session.sessionId !== sessionId)
    throw new Error('dispatch-native-session-diverged');
  return { sessionKey: context.sessionKey, sessionId, runId, toolCallId };
}
/** Host hooks supply invocation identity and receipts; the model cannot assert either. */
export default function createDispatchTool(input: {
  api: OpenClawPluginApi;
  config: OpenClawDispatchDependencies['config'];
  root: string;
  intake: OpenClawIntake;
  connect: OpenClawDispatchDependencies['connect'];
  automations: AutomationService;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  worktrees: Pick<TrustedGitWorktreeService, 'prepareGitHub' | 'inspectGitHub'>;
  credential: OpenClawDispatchDependencies['credential'];
  delivery?: OpenClawDispatchDependencies['delivery'];
  feedbackConnect?: OpenClawDispatchDependencies['feedbackConnect'];
}) {
  const { api } = input;
  const invocations = new Map<string, DispatchCaller & { agentId: string; operator: boolean }>();
  const loaded = async (context: NativeContext) => {
    if (!context.agentId) throw new Error('dispatch-agent-required');
    const result = await input.manifestService.loadForAgentId(context.agentId, 'service');
    if (result.status !== 'loaded' || result.manifest.agent.id !== context.agentId)
      throw new Error('dispatch-manifest-unavailable');
    return result;
  };
  const service = new OpenClawDispatch({
    root: input.root,
    config: input.config,
    credential: input.credential,
    intake: input.intake,
    worktrees: input.worktrees,
    connect: input.connect,
    delivery: input.delivery,
    feedbackConnect: input.feedbackConnect,
    async coordinator(manifest, workspace) {
      const { store } = await input.automations.scope(manifest, workspace);
      const job = openclawIntakeJobs(manifest).find(
        (entry) => entry.id === openclawIntakeAutomationId,
      );
      const ledger = await store.read();
      const record = ledger.records.find((entry) => entry.id === job?.id);
      if (!job || !record?.nativeId || record.removed)
        throw new Error('dispatch-automation-reconciliation-required');
      const unsupported = async (): Promise<never> => {
        throw new Error('dispatch-read-only-ownership');
      };
      const threads = new AutomationThreads(
        { root: input.automations.dependencies.root, scope: store.scope, runtime: 'openclaw' },
        { lookup: unsupported, create: unsupported, rename: unsupported },
      );
      const selection = automationThreadSelection(job, 'openclaw');
      const thread = (await threads.read()).records.find((entry) => entry.key === selection?.key);
      if (thread?.phase !== 'ready' || !thread.nativeId)
        throw new Error('dispatch-coordinator-binding-missing');
      return thread.nativeId;
    },
  });
  api.on('before_tool_call', async (event, context) => {
    if (event.toolName !== 'agent_system_dispatch') return;
    if (!context.agentId || !context.sessionKey) {
      if (event.params.action !== 'check')
        return { block: true, blockReason: 'dispatch-native-hook-context-unavailable' };
      return;
    }
    const nativeCaller = api.runtime.agent.session.getSessionEntry({
      sessionKey: context.sessionKey,
      readConsistency: 'latest',
    });
    // headless predicates have no conversation session ID; agent binding still applies in execute.
    if (event.params.action === 'check' && Value.Check(dispatchParameters, event.params)) return;
    try {
      const who = caller(context, event, nativeCaller);
      invocations.set(who.toolCallId, {
        ...who,
        agentId: context.agentId,
        operator: context.requester?.senderIsOwner === true,
      });
    } catch (error) {
      return {
        block: true,
        blockReason: `dispatch-native-hook-rejected: ${error instanceof Error ? error.message : 'caller-unavailable'}`,
      };
    }
  });
  api.on('after_tool_call', async (event, context) => {
    if (event.toolName !== 'agent_system_dispatch') return;
    invocations.delete(event.toolCallId ?? context.toolCallId ?? '');
  });
  const tool: RegisteredAgentSystemTool = {
    apiVersion: 1,
    id: 'dispatch',
    commands: [],
    toolNames: ['agent_system_dispatch'],
    isConfigured: (manifest) => manifest.github?.notifications?.schemaVersion === 2,
    invoke() {
      throw new AgentSystemToolError('tool_unavailable', 'Use the bound native dispatch tool.');
    },
    registerTools(registration) {
      // Keep this factory with its instance-local hooks; a name hint lets OpenClaw
      // substitute the Gateway tool without its captured caller or approval state.
      registration.registerTool((context) => ({
        name: 'agent_system_dispatch',
        label: 'Agent System Dispatch',
        description:
          'Coordinate admitted issues in their verified native session. Coordinator: consume saved discoveries, then iterate next, prepare, assess, reconcile within the retained native-run pass. Before stopping, call report and reproduce its response unchanged; empty means no card. Pending assessments and feedback permit next. Follow a returned nextAction of next for issue-scoped failures so unrelated eligible owners can continue; preserve the failed or uncertain operation without replaying it. Stop on pass-completed, idle, at-capacity, busy, or an actual native approval denial. Issue chat: present shows the saved assessment without renewing workflow permission; includeDetails true adds retained evidence and investigation on request; context/result refresh assessment; after showing the complete private assessment, use summary with operation compose, candidate, publish or reconcile for a separate concise user-journey summary. Freshly reconciled assessment-summary authority permits only that issue comment through native approval, never unrelated work or publication; use implementation-context before editing and implementation-result afterward. The context verifies the single planning-to-implementation transition from live Work policy, an Auto Work decision, or native operator direction for Plan. Handoff preview/apply remains compatible but is not a separate required grant. Delivery: prepare, publish with digest, reconcile, present. Delivery present reads the saved PR card without GitHub or Git access or fresh publication permission. Implementation includes ordinary PR delivery without a separate publication grant. Preserve explicit restrictions and native denials; unverified provider prose never selects authority. Feedback: use action feedback with operation context, implementation-context, implementation-result, delivery, result, compose, candidate or publish and the retained eventId. Feedback delivery uses deliveryOperation and the prepared digest. Only the verified feedback run may answer. Activated feedback policy authorizes routine source-bound replies through native approval. Verified feedback context reports the issue stage. Plan permits investigation and planning; Work permits appropriate implementation; Auto may select Plan or Work using a reasoned decision. Use feedback implementation-context to verify that stage and preserve the original issue result. Verified approved feedback may explicitly request implementation in Plan or Auto without an extra decision; use implementation-context and the same transition as direct task input. Keep a reasoned decision for autonomous Auto selection or a revised actionable plan. The coordinator may reconcile attempts but never compose or publish a new reply. Preserve the same chat/worktree and never recreate an uncertain PR.',
        parameters: dispatchParameters,
        async execute(id, params, signal) {
          signal?.throwIfAborted();
          if (!Value.Check(dispatchParameters, params)) throw new Error('dispatch-request-invalid');
          const binding = await loaded(context);
          let result;
          if (params.action === 'check')
            result = await service.check(
              binding.manifest,
              binding.scope.workspaceDir,
              signal,
              params.observation,
            );
          else {
            const who = invocations.get(id);
            invocations.delete(id);
            if (!who) throw new Error('dispatch-native-invocation-missing');
            if (
              who.agentId !== context.agentId ||
              who.sessionKey !== context.sessionKey ||
              (context.sessionId !== undefined && who.sessionId !== context.sessionId)
            )
              throw new Error(
                `dispatch-native-factory-mismatch: agentId=${who.agentId === context.agentId}; sessionKey=${who.sessionKey === context.sessionKey}; sessionIdPresent=${!!context.sessionId}; sessionId=${who.sessionId === context.sessionId}`,
              );
            context.assertInvocationCurrent?.();
            const current = api.runtime.agent.session.getSessionEntry({
              sessionKey: who.sessionKey,
              readConsistency: 'latest',
            });
            if (!current || current.sessionId !== who.sessionId || current.archivedAt)
              throw new Error('dispatch-native-session-diverged');
            const { operator, ...nativeCaller } = who;
            result = await service
              .run(
                binding.manifest,
                binding.scope.workspaceDir,
                nativeCaller,
                params,
                context.senderIsOwner === true && (params.action === 'retry' || operator),
                {
                  signal,
                  async assertCurrent() {
                    signal?.throwIfAborted();
                    context.assertInvocationCurrent?.();
                    const entry = api.runtime.agent.session.getSessionEntry({
                      sessionKey: who.sessionKey,
                      readConsistency: 'latest',
                    });
                    if (!entry || entry.sessionId !== who.sessionId || entry.archivedAt)
                      throw new Error('dispatch-native-session-diverged');
                    const fresh = await loaded(context);
                    if (
                      fresh.manifest.agent.id !== binding.manifest.agent.id ||
                      fresh.scope.workspaceDir !== binding.scope.workspaceDir
                    )
                      throw new Error('dispatch-workspace-binding-changed');
                  },
                },
              )
              .catch((error: unknown) => {
                const failure = {
                  ...workflowFailure(error, openClawDispatchFailureCode(error)),
                  code: openClawDispatchFailureCode(error),
                };
                return {
                  status: dispatchFailurePhase({}, failure.code, error),
                  ...failure,
                  ...workflowFailureScope('openclaw', 'dispatch', params),
                };
              });
          }
          if (result && 'providerDiagnostic' in result && result.providerDiagnostic) {
            const failure = workflowFailure(result, openClawDispatchFailureCode(result));
            result = {
              ...result,
              notice: codexIssueNotice({ event: 'failure', changed: true, ...failure }),
              presentationInstructions:
                'Show notice.message as the operation failure card. Preserve all retained work and reconcile uncertain writes before retrying.',
            };
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            details: result,
          };
        },
      }));
    },
  };
  return { tool, service };
}
