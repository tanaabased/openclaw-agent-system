import type { RegisteredAgentSystemTool } from '../../api/types.ts';
import loadBoundToolManifest from '../../api/manifest-binding.ts';
import AgentSystemToolError from '../../api/error.ts';
import initialModelRouting from '../../agent/initial-model-routing.ts';
import type AgentManifestService from '../../manifest/service.ts';
import { modelRoutingParameters } from './tool-schema.ts';

/** this read-only tool uses manifest binding without the credential-resolving command runtime. */
export default function createModelRoutingTool(
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>,
): RegisteredAgentSystemTool {
  return {
    apiVersion: 1,
    id: 'model-routing',
    commands: [],
    toolNames: ['agent_system_model_routing'],
    isConfigured: (manifest) => manifest.models !== undefined,
    guidance: {
      prompt:
        'For new routed work, use $agent-system-model-routing and agent_system_model_routing to inspect profiles and selected routing instructions, apply the selected method once, and validate your bounded assessment. Preserve saved selections on follow-ups; this helper never changes sessions.',
    },
    invoke() {
      throw new AgentSystemToolError(
        'tool_unavailable',
        'Use the active-agent native model routing tool.',
      );
    },
    registerTools(api) {
      api.registerTool(
        (context) => ({
          name: 'agent_system_model_routing',
          label: 'Agent System Model Routing',
          description:
            'Inspect bound model profiles or validate a bounded assessment with explicit selections. Read-only; does not call a model, resolve secrets, or change sessions.',
          parameters: modelRoutingParameters,
          async execute(_toolCallId, params) {
            const loaded = await loadBoundToolManifest(manifestService, {
              source: 'tool',
              toolContext: context,
            });
            const output = await initialModelRouting({
              models: loaded.manifest.models,
              manifestDigest: loaded.digest,
              request: params,
              runtime: 'openclaw',
              workspace: loaded.scope.workspaceDir,
            });
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(output) }],
              details: {},
            };
          },
        }),
        { name: 'agent_system_model_routing' },
      );
    },
  };
}
