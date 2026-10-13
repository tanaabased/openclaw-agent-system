import { Value } from 'typebox/value';

import { IntakeError } from '../../channels/github/intake/record-store.ts';

import type OpenClawIntake from '../../agent/openclaw-intake.ts';
import AgentSystemToolError from '../../api/error.ts';
import loadBoundToolManifest from '../../api/manifest-binding.ts';
import type { RegisteredAgentSystemTool } from '../../api/types.ts';
import type AgentManifestService from '../../manifest/service.ts';
import { intakeParameters } from './tool-schema.ts';

/** No caller-selected identity or credential route; scan admission belongs to V2 policy. */
export default function createIntakeTool(
  service: OpenClawIntake,
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>,
): RegisteredAgentSystemTool {
  return {
    apiVersion: 1,
    id: 'intake',
    commands: [],
    toolNames: ['agent_system_intake'],
    isConfigured: (manifest) => manifest.github?.notifications?.schemaVersion === 2,
    invoke() {
      throw new AgentSystemToolError('tool_unavailable', 'Use the bound native intake tool.');
    },
    registerTools(api) {
      api.registerTool(
        (context) => ({
          name: 'agent_system_intake',
          label: 'Agent System Intake',
          description:
            'Inspect V2 assignment intake, preview eligibility without writes, or persist a bounded scan. Agent-bound; never creates sessions or processes comments.',
          parameters: intakeParameters,
          async execute(_id, params, signal) {
            signal?.throwIfAborted();
            if (!Value.Check(intakeParameters, params))
              throw new IntakeError('intake-request-invalid');
            const loaded = await loadBoundToolManifest(manifestService, {
              source: 'tool',
              toolContext: context,
            });
            const result =
              params.action === 'inspect'
                ? await service.inspect(loaded.manifest, loaded.scope.workspaceDir)
                : await service.run(
                    loaded.manifest,
                    loaded.scope.workspaceDir,
                    params.action,
                    params.policyDigest,
                    signal,
                  );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              details: {},
            };
          },
        }),
        { name: 'agent_system_intake' },
      );
    },
  };
}
