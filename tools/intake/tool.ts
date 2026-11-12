import { Value } from 'typebox/value';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import { IntakeError } from '../../channels/github/intake/record-store.ts';
import contextMaterialTransport from '../../agent/context-material-transport.ts';
import IssuePickupFailure from '../../agent/issue-pickup-failure.ts';
import { AutomationError } from '../../agent/automation-gateway.ts';

import type OpenClawIntake from '../../agent/openclaw-intake.ts';
import type AutomationLifecycleAuthority from '../../agent/automation-lifecycle-authority.ts';
import AgentSystemToolError from '../../api/error.ts';
import loadBoundToolManifest from '../../api/manifest-binding.ts';
import type { RegisteredAgentSystemTool } from '../../api/types.ts';
import type AgentManifestService from '../../manifest/service.ts';
import { intakeParameters } from './tool-schema.ts';
import { nativeMaterialResponse } from '../../agent/native-material.ts';
import type { ImplementationMaterialRead } from '../../agent/tasks/implementation/implementation-material.ts';

/** No caller-selected identity or credential route; scan admission belongs to V2 policy. */
export default function createIntakeTool(
  service: OpenClawIntake,
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>,
  authorizePickup?: (
    context: Parameters<AutomationLifecycleAuthority['resolve']>[0],
  ) => Promise<{ nativeId: string; assertCurrent(): Promise<void> }>,
  hooks?: Pick<OpenClawPluginApi, 'on'>,
  readMaterial?: (
    scope: { sessionKey?: string; sessionId?: string },
    input: Record<string, unknown>,
    assertCurrent: () => Promise<void>,
  ) => Promise<Record<string, unknown>>,
): RegisteredAgentSystemTool {
  return {
    apiVersion: 1,
    id: 'intake',
    commands: [],
    toolNames: ['agent_system_intake'],
    isConfigured: (manifest) => Boolean(manifest.github?.notifications),
    invoke() {
      throw new AgentSystemToolError('tool_unavailable', 'Use the bound native intake tool.');
    },
    registerTools(api) {
      const pending = new Map<
        string,
        { runId?: string; authorization: { nativeId: string; assertCurrent(): Promise<void> } }
      >();
      const key = (
        context: { agentId?: string; sessionKey?: string; sessionId?: string },
        call: string,
      ) => JSON.stringify([context.agentId, context.sessionKey, context.sessionId, call]);
      const blocked = (reason: string) => ({
        block: true,
        blockReason: `issue-pickup-native-caller-required (${reason})`,
      });
      hooks?.on('before_tool_call', async (event, context) => {
        if (
          event.toolName !== 'agent_system_intake' ||
          (event.params as { action?: string }).action !== 'pickup'
        )
          return;
        const call = context.toolCallId ?? event.toolCallId;
        const runId = event.runId ?? context.runId;
        if (!call) return blocked('tool-call-id-missing');
        if (!authorizePickup) return blocked('automation-verifier-unavailable');
        if (!runId) return blocked('run-id-missing');
        if (event.runId && context.runId && event.runId !== context.runId)
          return blocked('run-id-mismatch');
        if (event.toolCallId && context.toolCallId && event.toolCallId !== context.toolCallId)
          return blocked('tool-call-id-mismatch');
        pending.delete(key(context, call));
        try {
          const authorization = await authorizePickup({ ...context, runId });
          pending.set(key(context, call), { authorization, runId });
        } catch (error) {
          const known = new Set([
            'automation-lifecycle-unverified',
            'automation-lifecycle-drift',
            'automation-observation-unavailable',
            'automation-native-response-invalid',
            'automation-run-context-missing',
            'automation-workspace-mismatch',
          ]);
          return blocked(
            error instanceof AutomationError && known.has(error.code)
              ? error.code
              : 'automation-authority-unavailable',
          );
        }
      });
      hooks?.on('after_tool_call', (event, context) => {
        const call = context.toolCallId ?? event.toolCallId;
        if (call) pending.delete(key(context, call));
      });
      hooks?.on('agent_end', (_event, context) => {
        for (const [id, entry] of pending) if (entry.runId === context.runId) pending.delete(id);
      });
      api.registerTool({
        contextVersion: 2,
        create: (context) => ({
          name: 'agent_system_intake',
          label: 'Agent System Intake',
          description:
            'Inspect assignment intake, preview eligibility, persist a scan, or select and self-assign one project issue from its verified pickup automation. Agent-bound; never creates sessions or processes comments.',
          parameters: intakeParameters,
          async execute(_id, params, signal) {
            signal?.throwIfAborted();
            if (!Value.Check(intakeParameters, params))
              throw new IntakeError('intake-request-invalid');
            const loaded = await loadBoundToolManifest(manifestService, {
              source: 'tool',
              toolContext: context,
            });
            const occurrence = pending.get(key(context, _id));
            pending.delete(key(context, _id));
            if (params.action === 'pickup' && !occurrence)
              throw new IntakeError('issue-pickup-tool-call-authorization-missing');
            let material: ImplementationMaterialRead | undefined;
            if (params.action === 'pickup' && params.material) {
              if (!readMaterial) throw new Error('material-native-reader-unavailable');
              const bound = await readMaterial(context, params, async () => {
                context.assertInvocationCurrent();
                await occurrence!.authorization.assertCurrent();
              });
              material = bound.material as ImplementationMaterialRead;
            }
            const result =
              params.action === 'pickup'
                ? await service
                    .pickup(
                      loaded.manifest,
                      loaded.scope.workspaceDir,
                      {
                        selection: params.selection,
                        material,
                      },
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                      {
                        nativeId: occurrence!.authorization.nativeId,
                        runId: occurrence!.runId,
                        async assertCurrent() {
                          context.assertInvocationCurrent();
                          await occurrence!.authorization.assertCurrent();
                          context.assertInvocationCurrent();
                        },
                      },
                    )
                    .catch((error: unknown) => {
                      if (!(error instanceof IssuePickupFailure)) throw error;
                      return error.failure;
                    })
                : params.action === 'inspect'
                  ? await service.inspect(loaded.manifest, loaded.scope.workspaceDir)
                  : await service.run(
                      loaded.manifest,
                      loaded.scope.workspaceDir,
                      params.action,
                      undefined,
                      signal,
                    );
            const delivered = contextMaterialTransport(
              nativeMaterialResponse(result, 'agent_system_intake', params),
              { tool: 'agent_system_intake' },
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(delivered) }],
              details: delivered,
            };
          },
        }),
      });
    },
  };
}
