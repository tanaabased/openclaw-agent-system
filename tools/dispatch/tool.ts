import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { Value } from 'typebox/value';
import codexIssueNotice from '../../agent/codex-issue-notice.ts';
import contextMaterialTransport from '../../agent/tasks/context/context-material-transport.ts';
import { dispatchFailurePhase } from '../../agent/tasks/dispatch/dispatch-retry.ts';
import nativeTaskInstructions from '../../agent/tasks/context/native-task-instructions.ts';
import openClawConditionCheck from '../../agent/openclaw-condition-check.ts';
import { readOpenClawTurnInput } from '../../agent/openclaw-turn-binding.ts';
import workflowFailure, { workflowFailureScope } from '../../agent/tasks/workflow-failure.ts';
import workflowNoticeInstructions from '../../agent/tasks/workflow-notice-instructions.ts';
import WorkflowRequestError from '../../agent/tasks/workflow-request-error.ts';

import type AutomationService from '../../agent/automations/automation-service.ts';
import AutomationThreads from '../../agent/automations/automation-threads.ts';
import { automationThreadSelection } from '../../agent/automations/automation-thread-selection.ts';
import OpenClawDispatch, {
  openClawDispatchFailureCode,
  type OpenClawDispatchDependencies,
} from '../../agent/tasks/dispatch/openclaw-dispatch.ts';
import openclawIntakeJobs, {
  openclawIntakeAutomationId,
} from '../../agent/automations/openclaw-intake-policy.ts';
import type OpenClawIntake from '../../agent/openclaw-intake.ts';
import type { DispatchCaller } from '../../agent/openclaw-session-create.ts';
import AgentSystemToolError from '../../api/error.ts';
import type { RegisteredAgentSystemTool } from '../../api/types.ts';
import type AgentManifestService from '../../manifest/service.ts';
import type TrustedGitWorktreeService from '../git/trusted-worktree-service.ts';
import {
  assertDispatchModelRequest,
  dispatchModelParameters,
  turnContextParameters,
} from './tool-schema.ts';

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
  claimStore?: OpenClawDispatchDependencies['claimStore'];
  claims?: OpenClawDispatchDependencies['claims'];
  intake: OpenClawIntake;
  taskContext: OpenClawDispatchDependencies['taskContext'];
  connect: OpenClawDispatchDependencies['connect'];
  automations: AutomationService;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  worktrees: Pick<TrustedGitWorktreeService, 'prepareGitHub' | 'inspectGitHub'>;
  credential: OpenClawDispatchDependencies['credential'];
  delivery?: OpenClawDispatchDependencies['delivery'];
  feedbackConnect?: OpenClawDispatchDependencies['feedbackConnect'];
  retirementDelivery?: OpenClawDispatchDependencies['retirementDelivery'];
  assessmentGit?: OpenClawDispatchDependencies['assessmentGit'];
}) {
  const { api } = input;
  api.on('before_prompt_build', async (_event, context) => {
    if (
      !context.runId ||
      !context.jobId ||
      !context.agentId ||
      !context.sessionKey ||
      !context.sessionId
    )
      return;
    api.runContext.setRunContext({
      runId: context.runId,
      namespace: 'dispatch-occurrence',
      value: {
        agentId: context.agentId,
        sessionKey: context.sessionKey,
        sessionId: context.sessionId,
        jobId: context.jobId,
      },
    });
  });
  // Descriptive reads do not replace the live host invocation guard at effect boundaries.
  const assertSessionCurrent = async (sessionKey: string, sessionId: string) => {
    const entry = await api.runtime.agent.session.getSessionEntryAsync({
      sessionKey,
      readConsistency: 'latest',
    });
    if (!entry || entry.sessionId !== sessionId || entry.archivedAt)
      throw new Error('dispatch-native-session-diverged');
  };
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
    claimStore: input.claimStore,
    claims: input.claims,
    config: input.config,
    credential: input.credential,
    intake: input.intake,
    taskContext: input.taskContext,
    worktrees: input.worktrees,
    connect: input.connect,
    delivery: input.delivery,
    feedbackConnect: input.feedbackConnect,
    retirementDelivery: input.retirementDelivery,
    assessmentGit: input.assessmentGit,
    occurrenceStartedAt: (manifest, workspace, caller) =>
      input.automations.occurrenceStartedAt(
        manifest,
        workspace,
        openclawIntakeAutomationId,
        caller,
      ),
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
    if (!['agent_system_dispatch', 'agent_system_context'].includes(event.toolName)) return;
    if (!context.agentId || !context.sessionKey) {
      if (event.params.action !== 'check')
        return { block: true, blockReason: 'dispatch-native-hook-context-unavailable' };
      return;
    }
    const nativeCaller = await api.runtime.agent.session.getSessionEntryAsync({
      sessionKey: context.sessionKey,
      readConsistency: 'latest',
    });
    // headless predicates have no conversation session ID; agent binding still applies in execute.
    if (event.params.action === 'check' && Value.Check(dispatchModelParameters, event.params))
      return;
    try {
      const who = caller(context, event, nativeCaller);
      const occurrence = api.runContext.getRunContext({
        runId: who.runId,
        namespace: 'dispatch-occurrence',
      });
      if (
        occurrence &&
        typeof occurrence === 'object' &&
        !Array.isArray(occurrence) &&
        occurrence.agentId === context.agentId &&
        occurrence.sessionKey === who.sessionKey &&
        occurrence.sessionId === who.sessionId &&
        typeof occurrence.jobId === 'string'
      )
        who.jobId = occurrence.jobId;
      const inputId = readOpenClawTurnInput(api.runContext, { ...who, agentId: context.agentId });
      context.abortSignal?.throwIfAborted();
      invocations.set(who.toolCallId, {
        ...who,
        ...(inputId ? { inputId } : {}),
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
    if (!['agent_system_dispatch', 'agent_system_context'].includes(event.toolName)) return;
    invocations.delete(event.toolCallId ?? context.toolCallId ?? '');
  });
  const tool: RegisteredAgentSystemTool = {
    apiVersion: 1,
    id: 'dispatch',
    commands: [],
    toolNames: ['agent_system_dispatch', 'agent_system_context'],
    isConfigured: () => true,
    invoke() {
      throw new AgentSystemToolError('tool_unavailable', 'Use the bound native dispatch tool.');
    },
    registerTools(registration) {
      // Keep this factory with its instance-local hooks; a name hint lets OpenClaw
      // substitute the Gateway tool without its captured caller or approval state.
      // headless conditions use the compatible factory; v2 requires an admitted model run.
      for (const contextOnly of [false, true])
        registration.registerTool((context) => ({
          name: contextOnly ? 'agent_system_context' : 'agent_system_dispatch',
          label: contextOnly ? 'Agent System Context' : 'Agent System Dispatch',
          description: contextOnly
            ? 'Read usable context for this native task with {}. No action, target, path, IDs, or other arguments. The runtime resolves the current task, exact incoming feedback, and configured guidance. Use when managed issue context is expected but missing or needs refreshing; no second context call is required. Ordinary home chats and general automation/intake return unmanaged-turn; continue native work without issue recovery. This read does not authorize external effects.'
            : 'Managed task context normally arrives through the native hook; if expected but missing, use agent_system_context with {}. Ordinary home chats and general automation/intake need no issue context; unmanaged-turn is normal, not a workflow failure. Use dispatch for explicitly requested Agent System operations and existing admitted workflows. Ordinary native chat creation, context handoffs, research and authorized implementation stay native; an issue reference or repository does not request enrollment. Do not require repeated human authorization or transfer managed ownership for a native handoff. ' +
              'Operator recovery: action recover selects the predecessor by issue target or explicit chat and same-repository pullRequest. The runtime verifies native operator input and reserves one successor internally; preview:true is optional. Never supply receipt IDs or digests. Preserve old work and native denials. Existing-task delivery bind selects and verifies an explicit PR in one native-approved call. Delivery publish accepts authored title/body and an optional base branch and resolves its task and checkout internally; prepare is an optional preview. Do not supply task IDs or digests to delivery operations. Manual launch: action launch with operation context accepts an explicit issue or open same-repository PR reference without prior assignment or intake activation. New issue-launch requests attempt additive self-assignment and create independent tasks through normal dispatch, bypassing automatic routing and capacity; existing tasks and claims do not veto launch. Use the same target with launch prepare, then reconcile uncertain creation through that target. Retries and existing PR continuation reuse their exact destinations and stages; never fabricate assignment or schedule evidence. Missing enrollment needs explicit Install with manualSessionDispatch:true, never automatic enrollment. See $agent-system-task-launch. ' +
              'Read-only response assembly: action response gathers current-turn presentation output with optional blocks of {section, markdown} for ordinary prose. No IDs or receipts. Preserve the complete composed Markdown and any later addendum; formatting never gates work or repeats effects. ' +
              'Direct assessment: action assessment with operation context accepts an explicit GitHub issue target and existing checkout path in the current chat. It uses current agent assessment configuration without intake activation. Use the returned selected method once, then assessment render with target and the full result. It returns native tool context and a concise presentation without saving a plan or summary. All outputs remain assessment-only; no assignment, setup, implementation or publication. Invalid managed context never falls back to manual. ' +
              'Manual managed-task retirement: action retire accepts a target issue URL or the current verified issue session, resolves ownership internally, and applies cleanup. Use preview:true for optional inspection; never supply IDs or digests. Only native owner input authorizes retirement. Reuse existing safe cleanup immediately; running work and incomplete native cleanup remain pending. Never fall back to unmanaged cleanup. ' +
              'Explicit unmanaged cleanup: action retire with native set to an exact session key (OpenClaw) or thread id (standalone Codex), performs normal native disposal using existing operator intent. Use preview:true for optional inspection; no copied digest or another conversational confirmation is required. Native cleanup may stop work, archive descendants or reclaim native checkouts/local branches and lose local-only work. No preservation audit, enrollment or issue/assignment/remote-branch changes. Known managed targets must use managed retirement. Honor native denial; reconcile the original attempt and distinguish archived history from disk reclamation. ' +
              'Operator status updates: action reply with operation context and purpose status-update reads bounded public facts and the verified owner outcomes. Reconcile only material missing facts, then compose with purpose status-update and update {facts:[{reference,text}]}; empty facts means no-op without a composer. Reconcile an uncertain overlapping publication through its original receipt; unrelated updates remain independent. Preserve task mode and lifecycle. Direct reply: action reply with operation compose accepts an exact GitHub target URL and supplied privateText/outcome in the current chat. It resolves the invoking agent configuration without intake activation and returns ordinary composition inputs or an exact existing-reply route. A newly authorized independent comment does not require destination task ownership or transfer; destination records grant no publication authority. Existing attempts retain their original source, text and reconciliation owner. Use candidate to retain and show a draft; only an explicit user publication request authorizes publish with the exact target and publicText through native approval. Reconcile uncertain attempts without reposting. Never treat invalid managed context as manual entry. ' +
              'Direct implementation: action implementation with operation context collects an authorized plan, issue target and existing checkout in the current chat, or reuses matching retained work. Use the returned configured implementation body once; never bootstrap verified implementation context again. Manual scope defaults to local; select pull-request scope only for an explicit operator publication request, never from a plan. Implementation output stays in native conversation; follow current native conversation direction and use the delivery operations for authorized PR publication. Invalid managed work never becomes manual. ' +
              'Coordinator: consume saved discoveries through next, prepare, assess and reconcile. Create the initial issue conversation once, deliver eligible feedback and inspect existing request receipts. Never send implementation, Auto-decision, missing-result or reporting nudges. Follow nextAction next after an isolated failure; preserve denials and uncertain effects at their original owners. Finish with report and reproduce its response unchanged. ' +
              nativeTaskInstructions('openclaw') +
              ' ' +
              'Delivery prepare/publish verifies each external operation; link changes the current association independently of present and the originating-issue announcement. ' +
              'Feedback: use the verified source supplied in native task context. If missing, refresh with agent_system_context {}. Use action feedback with source only when deliberately selecting another comment URL. Handle the returned content as native input. Use reply compose at replyTarget with your response as privateText, then candidate and publish. Approved non-self feedback authorizes its routine reply without another human confirmation; self feedback stays private. A progress question may use Task Update at that exact source and deserves an answer even when progress is unchanged. Recover replies independently of incoming delivery, never replay consumed input because a reply is missing. ',

          parameters: contextOnly ? turnContextParameters : dispatchModelParameters,
          async execute(id, rawParams, signal) {
            if (contextOnly && !Value.Check(turnContextParameters, rawParams))
              throw new WorkflowRequestError(
                'turn-context-request-invalid',
                'Call agent_system_context with {}; binding overrides are not accepted.',
              );
            const params = contextOnly ? { action: 'context' } : rawParams;
            signal?.throwIfAborted();
            assertDispatchModelRequest(params, 'dispatch-request-invalid');
            let result;
            if (params.action === 'check')
              result = await openClawConditionCheck(async (budget) => {
                const binding = await budget.read('manifest-binding', () => loaded(context));
                return service.check(
                  binding.manifest,
                  binding.scope.workspaceDir,
                  signal,
                  undefined,
                  undefined,
                  budget,
                );
              }, signal);
            else {
              const binding = await loaded(context);
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
              const assertCurrent = () => {
                signal?.throwIfAborted();
                context.assertInvocationCurrent?.();
              };
              await assertSessionCurrent(who.sessionKey, who.sessionId);
              assertCurrent();
              const { operator, ...nativeCaller } = who;
              result = await service
                .runModel(
                  binding.manifest,
                  binding.scope.workspaceDir,
                  nativeCaller,
                  params,
                  context.senderIsOwner === true && (params.action === 'retry' || operator),
                  {
                    signal,
                    async assertCurrent() {
                      assertCurrent();
                      const fresh = await loaded(context);
                      await assertSessionCurrent(who.sessionKey, who.sessionId);
                      assertCurrent();
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
                    ...workflowFailure(error, openClawDispatchFailureCode(error), 'dispatch'),
                    code: openClawDispatchFailureCode(error),
                  };
                  return {
                    status: dispatchFailurePhase({}, failure.code, error),
                    ...failure,
                    ...workflowFailureScope('openclaw', 'dispatch', params),
                    notice: codexIssueNotice({ event: 'failure', changed: true, ...failure }),
                    presentationInstructions: workflowNoticeInstructions(true),
                  };
                });
            }
            if (result && 'providerDiagnostic' in result && result.providerDiagnostic) {
              const failure = workflowFailure(result, openClawDispatchFailureCode(result));
              result = {
                ...result,
                notice: codexIssueNotice({ event: 'failure', changed: true, ...failure }),
                presentationInstructions: workflowNoticeInstructions(true),
              };
            }
            const delivered = contextMaterialTransport(result, { tool: 'agent_system_dispatch' });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(delivered) }],
              details: delivered,
            };
          },
        }));
    },
  };
  return { tool, service };
}
