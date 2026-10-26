import type { AgentModelsConfiguration } from '../manifest/models-schema.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import routingInstructions, {
  assertRoutingInstructions,
  routingInstructionsDigest,
  routingInstructionsGuidance,
} from './routing-instructions.ts';

/** explicit initial consumers load guidance; the deterministic resolver stays side-effect free. */
export default async function initialModelRouting(input: {
  models: AgentModelsConfiguration | undefined;
  manifestDigest: string;
  request: unknown;
  runtime: 'codex' | 'openclaw';
  workspace: string;
  observedAt?: number;
  resolveSkill?: (id: string) => Promise<CodexAssessmentSkill>;
}) {
  const output = resolveModelRoutingRequest(
    input.models,
    input.manifestDigest,
    input.request,
    input.runtime,
  );
  if (!input.models)
    return {
      ...output,
      instructions: undefined,
      instructionsDigest: undefined,
      instructionsGuidance: undefined,
    };
  const instructions = await routingInstructions({
    configuration: input.models.routing,
    workspace: input.workspace,
    observedAt: input.observedAt ?? Date.now(),
    resolveSkill: input.resolveSkill,
  });
  const request = input.request as { action: 'inspect' | 'resolve'; instructionsDigest?: string };
  if (request.action === 'resolve')
    assertRoutingInstructions(instructions, request.instructionsDigest);
  return {
    ...output,
    instructions,
    instructionsDigest: routingInstructionsDigest(instructions),
    instructionsGuidance: routingInstructionsGuidance,
  };
}
