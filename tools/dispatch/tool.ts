import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import type { OpenClawPluginApi, PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveSessionModelRef } from 'openclaw/plugin-sdk/model-session-runtime';
import { listSkillCommandsForWorkspace } from 'openclaw/plugin-sdk/skill-commands-runtime';
import { Value } from 'typebox/value';

import assessmentSkillSource from '../../agent/assessment-skill-source.ts';
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
import type { DispatchCaller } from '../../agent/openclaw-dispatch-handoff.ts';
import type OpenClawIntake from '../../agent/openclaw-intake.ts';
import type { RegisteredAgentSystemTool } from '../../api/types.ts';
import AgentSystemToolError from '../../api/error.ts';
import { normalizeAssessmentSkillId } from '../../manifest/assessment-schema.ts';
import type AgentManifestService from '../../manifest/service.ts';
import type TrustedGitWorktreeService from '../git/trusted-worktree-service.ts';
import type { AgentSystemHookContext } from '../../core/agent-hook-context.ts';
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
function receipt(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== 'object') return;
  if ('details' in result) return receipt(result.details);
  if ('content' in result && Array.isArray(result.content)) {
    const text = result.content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (text.length > 32000) return;
    try {
      return receipt(JSON.parse(text));
    } catch {
      return;
    }
  }
  return result as Record<string, unknown>;
}

/** Host hooks supply invocation identity and receipts; the model cannot assert either. */
export default function createDispatchTool(input: {
  api: OpenClawPluginApi;
  root: string;
  intake: OpenClawIntake;
  connect: OpenClawDispatchDependencies['connect'];
  automations: AutomationService;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  worktrees: Pick<TrustedGitWorktreeService, 'prepareGitHub' | 'inspectGitHub'>;
  diagnostics?: Pick<PluginLogger, 'info'>;
  runtimeUrl?: string;
}) {
  const { api } = input;
  const invocations = new Map<string, DispatchCaller & { agentId: string }>();
  const instance = randomUUID();
  let sequence = 0;
  const fingerprint = (value: string | undefined) =>
    value ? createHash('sha256').update(value).digest('hex').slice(0, 20) : null;
  const trace = (
    stage: 'registered' | 'hook' | 'captured' | 'execute' | 'cleanup',
    context: NativeContext = {},
    event: Pick<NativeContext, 'runId' | 'toolCallId'> = {},
    executeId?: string,
  ) => {
    if (!input.diagnostics) return;
    const callId = executeId ?? event.toolCallId ?? context.toolCallId;
    const captured = callId ? invocations.get(callId) : undefined;
    try {
      input.diagnostics.info(
        `dispatch-invocation ${JSON.stringify({
          version: 1,
          instance,
          process: process.pid,
          sequence: ++sequence,
          stage,
          ...(stage === 'registered'
            ? {
                source: api.source,
                runtimeSource: api.runtimeSource,
                runtimeUrl: input.runtimeUrl,
                rootDir: api.rootDir,
                registrationMode: api.registrationMode,
                constructionStack: new Error().stack?.split('\n').slice(1),
              }
            : {}),
          agent: fingerprint(context.agentId),
          session: fingerprint(context.sessionKey),
          incarnation: fingerprint(context.sessionId),
          contextRun: fingerprint(context.runId),
          eventRun: fingerprint(event.runId),
          contextCall: fingerprint(context.toolCallId),
          eventCall: fingerprint(event.toolCallId),
          executeCall: fingerprint(executeId),
          capturedRun: fingerprint(captured?.runId),
          capturedIncarnation: fingerprint(captured?.sessionId),
          capturePresent: !!captured,
          pendingCaptures: invocations.size,
        })}`,
      );
    } catch {
      // Diagnostics must not change admission or consume invocation authority.
    }
  };
  trace('registered');
  const loaded = async (context: NativeContext) => {
    if (!context.agentId) throw new Error('dispatch-agent-required');
    const result = await input.manifestService.loadForAgentId(context.agentId, 'service');
    if (result.status !== 'loaded' || result.manifest.agent.id !== context.agentId)
      throw new Error('dispatch-manifest-unavailable');
    return result;
  };
  const service = new OpenClawDispatch({
    root: input.root,
    intake: input.intake,
    worktrees: input.worktrees,
    connect: input.connect,
    preflight(manifest) {
      const allowed =
        openclawIntakeJobs(manifest).find((job) => job.id === openclawIntakeAutomationId)
          ?.internalOpenClaw?.toolsAllow ?? [];
      if (
        !allowed.includes('*') &&
        !['read', 'agent_system_git', 'agent_system_github'].every((name) => allowed.includes(name))
      )
        throw new Error('dispatch-assessment-tools-approval-required');
    },
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
    native: {
      async read(sessionKey) {
        const entry = api.runtime.agent.session.getSessionEntry({
          sessionKey,
          readConsistency: 'latest',
        });
        if (!entry?.sessionId || !entry.parentSessionKey || !entry.spawnedCwd || entry.archivedAt)
          throw new Error('dispatch-native-session-unavailable');
        const parent = api.runtime.agent.session.getSessionEntry({
          sessionKey: entry.parentSessionKey,
          readConsistency: 'latest',
        });
        if (
          !parent?.sessionId ||
          (entry.parentSessionId && entry.parentSessionId !== parent.sessionId)
        )
          throw new Error('dispatch-native-parent-diverged');
        const model = resolveSessionModelRef(api.config, entry);
        return {
          sessionKey,
          sessionId: entry.sessionId,
          parentSessionKey: entry.parentSessionKey,
          parentSessionId: parent.sessionId,
          cwd: await realpath(entry.spawnedCwd),
          model: `${model.provider}/${model.model}`,
          effort: entry.thinkingLevel,
        };
      },
    },
    async skill(workspace, sessionKey, id) {
      const requested = normalizeAssessmentSkillId(id);
      const name = requested.startsWith('agent-system:')
        ? requested.slice('agent-system:'.length)
        : requested;
      const entry = api.runtime.agent.session.getSessionEntry({
        sessionKey,
        readConsistency: 'latest',
      });
      const skills = listSkillCommandsForWorkspace({
        workspaceDir: workspace,
        cfg: api.config,
        sessionKey,
        sessionEntry: entry,
      });
      const matches = skills.filter(
        (skill) => skill.skillName === name && skill.modelVisible !== false,
      );
      if (matches.length !== 1 || !matches[0]?.skillFile)
        throw new Error(
          matches.length > 1
            ? 'dispatch-assessment-skill-ambiguous'
            : 'dispatch-assessment-skill-unavailable',
        );
      return assessmentSkillSource({
        name: matches[0].skillName,
        path: matches[0].skillFile,
        scope: matches[0].skillSource ?? 'openclaw',
      });
    },
  });
  api.on('before_tool_call', async (event, context) => {
    if (event.toolName === 'agent_system_dispatch' && event.params.action !== 'check')
      trace('hook', context, event);
    if (!context.agentId || !context.sessionKey) {
      if (event.toolName === 'agent_system_dispatch' && event.params.action !== 'check')
        return { block: true, blockReason: 'dispatch-native-hook-context-unavailable' };
      return;
    }
    const nativeCaller = api.runtime.agent.session.getSessionEntry({
      sessionKey: context.sessionKey,
      readConsistency: 'latest',
    });
    if (nativeCaller?.parentSessionKey) {
      const binding = await loaded(context);
      if (binding.manifest.github?.notifications?.schemaVersion === 2) {
        const current = await service.scope(binding.manifest, binding.scope.workspaceDir);
        const state = await current.journal.read();
        const managed = state.records.find(
          (entry) =>
            entry.threadId === context.sessionKey ||
            (!entry.native &&
              entry.creationCall &&
              entry.sourceThreadId === nativeCaller.parentSessionKey &&
              entry.worktree === nativeCaller.spawnedCwd),
        );
        if (
          managed &&
          (!managed.setupComplete ||
            !managed.continuation?.runId ||
            managed.native?.runId === (event.runId ?? context.runId))
        )
          return {
            block: true,
            blockReason: 'dispatch-setup-only; assessment continuation is not verified',
          };
      }
    }
    if (event.toolName === 'agent_system_dispatch') {
      // headless predicates have no conversation session ID; agent binding still applies in execute.
      if (event.params.action === 'check' && Value.Check(dispatchParameters, event.params)) return;
      try {
        const who = caller(context, event, nativeCaller);
        invocations.set(who.toolCallId, { ...who, agentId: context.agentId });
        trace('captured', context, event);
      } catch (error) {
        return {
          block: true,
          blockReason: `dispatch-native-hook-rejected: ${error instanceof Error ? error.message : 'caller-unavailable'}`,
        };
      }
      return;
    }
    if (!['sessions_spawn', 'sessions_send'].includes(event.toolName)) return;
    const binding = await loaded(context);
    if (binding.manifest.github?.notifications?.schemaVersion !== 2) return;
    let owned = false;
    try {
      const current = await service.scope(binding.manifest, binding.scope.workspaceDir);
      const state = await current.journal.read();
      // Only retained dispatch requests bind a native action; unrelated user delegation is untouched.
      owned = state.records.some((entry) => entry.sourceThreadId === context.sessionKey);
      const record = state.records.find(
        (entry) =>
          entry.sourceThreadId === context.sessionKey &&
          (event.toolName === 'sessions_spawn'
            ? entry.request && automationHash(entry.request) === automationHash(event.params)
            : entry.threadId === event.params.sessionKey),
      );
      if (!record) {
        if (owned) return { block: true, blockReason: 'dispatch-native-request-mismatch' };
        return;
      }
      owned = true;
      const who = caller(context, event, nativeCaller);
      const handoff = await service.handoff(binding.manifest, binding.scope.workspaceDir);
      if (event.toolName === 'sessions_spawn')
        await handoff.claimCreation(record.id, who, event.params);
      else await handoff.claimContinuation(record.id, who, event.params);
    } catch (error) {
      if (owned)
        return {
          block: true,
          blockReason: error instanceof Error ? error.message : 'dispatch-native-action-blocked',
        };
      throw error;
    }
  });
  api.on('after_tool_call', async (event, context) => {
    if (event.toolName === 'agent_system_dispatch') {
      if (event.params.action !== 'check') trace('cleanup', context, event);
      invocations.delete(event.toolCallId ?? context.toolCallId ?? '');
      return;
    }
    if (!['sessions_spawn', 'sessions_send'].includes(event.toolName) || !context.agentId) return;
    const binding = await loaded(context);
    if (binding.manifest.github?.notifications?.schemaVersion !== 2) return;
    const current = await service.scope(binding.manifest, binding.scope.workspaceDir);
    const state = await current.journal.read();
    const callId = event.toolCallId ?? context.toolCallId;
    const record = state.records.find(
      (entry) =>
        entry.sourceThreadId === context.sessionKey &&
        (event.toolName === 'sessions_spawn'
          ? entry.creationCall?.toolCallId === callId
          : entry.continuation?.toolCallId === callId),
    );
    if (!record) return;
    const observed = receipt(event.result);
    if (event.error || observed?.status !== 'accepted' || typeof observed.runId !== 'string')
      return;
    const who = caller(
      context,
      event,
      api.runtime.agent.session.getSessionEntry({
        sessionKey: context.sessionKey!,
        readConsistency: 'latest',
      }),
    );
    const handoff = await service.handoff(binding.manifest, binding.scope.workspaceDir);
    if (event.toolName === 'sessions_spawn' && typeof observed.childSessionKey === 'string') {
      await handoff.observeCreation(record.id, who, {
        sessionKey: observed.childSessionKey,
        runId: observed.runId,
      });
    } else if (event.toolName === 'sessions_send')
      await handoff.observeContinuation(record.id, who, observed.runId);
  });
  api.on('agent_end', async (event, context) => {
    if (
      !context.agentId ||
      !context.sessionKey ||
      !context.sessionId ||
      !(event.runId ?? context.runId)
    )
      return;
    const binding = await loaded(context);
    if (binding.manifest.github?.notifications?.schemaVersion !== 2) return;
    const current = await service.scope(binding.manifest, binding.scope.workspaceDir);
    const state = await current.journal.read();
    const record = state.records.find((entry) => entry.native?.sessionKey === context.sessionKey);
    const runId = event.runId ?? context.runId!;
    if (record?.native?.runId === runId) {
      await (
        await service.handoff(binding.manifest, binding.scope.workspaceDir)
      ).observeSetupEnd(
        record.id,
        { sessionKey: context.sessionKey, sessionId: context.sessionId, runId },
        event.success,
      );
    } else if (!record) {
      const native = api.runtime.agent.session.getSessionEntry({
        sessionKey: context.sessionKey,
        readConsistency: 'latest',
      });
      const pending = state.records.filter(
        (entry) =>
          entry.creationCall &&
          !entry.native &&
          entry.sourceThreadId === native?.parentSessionKey &&
          entry.worktree === native.spawnedCwd,
      );
      if (pending.length === 1)
        await (
          await service.handoff(binding.manifest, binding.scope.workspaceDir)
        ).observeSetupEnd(
          pending[0]!.id,
          { sessionKey: context.sessionKey, sessionId: context.sessionId, runId },
          event.success,
        );
    }
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
      registration.registerTool(
        (context) => ({
          name: 'agent_system_dispatch',
          label: 'Agent System Dispatch',
          description:
            'Route admitted V2 issues, verify native issue-chat handoffs, and retain assessment results. Uses the invoking session and agent; cannot publish or implement.',
          parameters: dispatchParameters,
          async execute(id, params, signal) {
            signal?.throwIfAborted();
            if (!Value.Check(dispatchParameters, params))
              throw new Error('dispatch-request-invalid');
            const binding = await loaded(context);
            let result;
            if (params.action === 'check')
              result = await service.check(binding.manifest, binding.scope.workspaceDir);
            else {
              trace('execute', context, {}, id);
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
              if (params.action === 'context' || params.action === 'result') {
                // Plugin identity stays workspace-bound; the native receipt verifies execution cwd.
                if (
                  !context.workspaceDir ||
                  (await realpath(context.workspaceDir)) !==
                    (await realpath(binding.scope.workspaceDir))
                )
                  throw new Error('dispatch-native-workspace-mismatch');
              }
              const model = context.activeModel;
              result = await service.run(
                binding.manifest,
                binding.scope.workspaceDir,
                who,
                params,
                model?.modelRef ??
                  (model?.provider && model.modelId
                    ? `${model.provider}/${model.modelId}`
                    : undefined),
                context.senderIsOwner === true,
              );
            }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              details: result,
            };
          },
        }),
        { name: 'agent_system_dispatch' },
      );
    },
  };
  return {
    tool,
    service,
    async instructions(context: AgentSystemHookContext) {
      if (!context.agentId || !context.sessionKey) return;
      const native = api.runtime.agent.session.getSessionEntry({
        sessionKey: context.sessionKey,
        readConsistency: 'latest',
      });
      if (!native?.parentSessionKey) return;
      const binding = await loaded(context);
      if (
        binding.manifest.github?.notifications?.schemaVersion !== 2 ||
        binding.manifest.github.notifications.issueAssignment?.mode !== 'plan'
      )
        return;
      const current = await service.scope(binding.manifest, binding.scope.workspaceDir);
      const record = (await current.journal.read()).records.find(
        (entry) => entry.threadId === context.sessionKey,
      );
      if (!record || record.retired || record.handoff) return;
      if (!record.setupComplete || !record.continuation?.runId)
        return 'Agent System setup-only turn. Do not investigate or use tools. Assessment requires a separate verified continuation.';
      return `Agent System retained assessment receipt: ${record.id}. Before investigation or revision, call agent_system_dispatch action context with this id. This receipt is a lookup key, not assignment authority. Use only returned verified evidence, saved routing, selected skill and result contract. Stay in this issue chat; do not implement or publish. Failed verification is a blocker, not permission to create another chat.`;
    },
  };
}
