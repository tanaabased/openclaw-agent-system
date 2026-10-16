import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { Value } from 'typebox/value';

import { automationHash } from '../../agent/automation-hash.ts';
import { effectiveAutomation } from '../../agent/automation-projection.ts';
import AutomationThreads, { automationThreadSelection } from '../../agent/automation-threads.ts';
import type AutomationService from '../../agent/automation-service.ts';
import openclawIntakeJobs, {
  openclawIntakeAutomationId,
} from '../../agent/openclaw-intake-policy.ts';
import OpenClawDispatch, {
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
}) {
  const { api } = input;
  const invocations = new Map<string, DispatchCaller & { agentId: string }>();
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
    async coordinator(manifest, workspace) {
      const { store, context } = await input.automations.scope(manifest, workspace);
      const job = openclawIntakeJobs(manifest).find(
        (entry) => entry.id === openclawIntakeAutomationId,
      );
      const ledger = await store.read();
      const record = ledger.records.find((entry) => entry.id === job?.id);
      if (
        !job ||
        !record?.nativeId ||
        record.pending ||
        record.removed ||
        record.hash !== effectiveAutomation(job, context).hash
      )
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
      invocations.set(who.toolCallId, { ...who, agentId: context.agentId });
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
          'Coordinate assigned-issue assessment in a verified ordinary session. Coordinator: next, prepare, assess, reconcile; start retains the earlier bounded-investigation operation. Issue session only: context and result, using the saved receipt id. Results retain the full shared assessment and revisions with previousResultDigest. Reconcile never resends an attempted turn or creates a replacement. No implementation or publication.',
        parameters: dispatchParameters,
        async execute(id, params, signal) {
          signal?.throwIfAborted();
          if (!Value.Check(dispatchParameters, params)) throw new Error('dispatch-request-invalid');
          const binding = await loaded(context);
          let result;
          if (params.action === 'check')
            result = await service.check(binding.manifest, binding.scope.workspaceDir);
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
            result = await service
              .run(
                binding.manifest,
                binding.scope.workspaceDir,
                who,
                params,
                context.senderIsOwner === true,
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
                      automationHash(fresh.manifest) !== automationHash(binding.manifest) ||
                      fresh.scope.workspaceDir !== binding.scope.workspaceDir
                    )
                      throw new Error('dispatch-policy-changed');
                  },
                },
              )
              .catch((error: unknown) => {
                return {
                  status: 'blocked',
                  code:
                    error instanceof Error && /^[a-z][a-z0-9-]{2,127}$/.test(error.message)
                      ? error.message
                      : 'dispatch-operation-failed',
                };
              });
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
