import { Type, type Static } from 'typebox';

import assessmentGuidance from './assessment-guidance.ts';
import { assessmentSelectionSchema } from './assessment-selection.ts';
import { automationHash } from './automation-hash.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';
import { RoutingError } from './model-routing.ts';
import {
  normalizeAssessmentSkillId,
  type AssessmentConfiguration,
} from '../manifest/assessment-schema.ts';

export const defaultRoutingSkill = 'agent-system:agent-system-model-routing';
export const routingInstructionsSchema = Type.Object(
  {
    ...assessmentSelectionSchema.properties,
    skill: Type.Optional(assessmentSelectionSchema.properties.skill),
  },
  { additionalProperties: false },
);
export type RoutingInstructions = Static<typeof routingInstructionsSchema>;

/** native discovery is optional for direct helpers; never trust caller-supplied source paths. */
export default async function routingInstructions(input: {
  configuration?: AssessmentConfiguration;
  workspace: string;
  observedAt: number;
  resolveSkill?: (id: string) => Promise<CodexAssessmentSkill>;
}): Promise<RoutingInstructions> {
  const requestedSkill = normalizeAssessmentSkillId(
    input.configuration?.skill ?? defaultRoutingSkill,
  );
  const defaultSkill = [defaultRoutingSkill, 'agent-system-model-routing'].includes(requestedSkill);
  const skill =
    !defaultSkill && input.resolveSkill ? await input.resolveSkill(requestedSkill) : undefined;
  const guidance = await assessmentGuidance(input.workspace, input.configuration?.guidance);
  return {
    version: 1,
    requestedSkill,
    defaultSkill,
    ...(skill ? { skill } : {}),
    ...(guidance ? { guidance } : {}),
    observedAt: input.observedAt,
  };
}

export function routingInstructionsDigest(selection: RoutingInstructions): string {
  return automationHash({ ...selection, observedAt: undefined });
}

export function assertRoutingInstructions(
  current: RoutingInstructions,
  previous?: RoutingInstructions | string,
): void {
  const expected =
    typeof previous === 'string' ? previous : previous && routingInstructionsDigest(previous);
  if (expected === undefined && current.defaultSkill && !current.guidance) return;
  if (expected !== routingInstructionsDigest(current))
    throw new RoutingError(
      'model-routing-instructions-changed',
      'Inspect the current routing instructions and reassess before preparing new work.',
    );
}

export const routingInstructionsGuidance =
  'Use the selected routing method once. For defaultSkill, use the supplied rubric without invoking the wrapper again. Otherwise read and apply requestedSkill through native skill discovery (or its verified skill source), preserving its complete output and adapting only its judgment to the bounded assessment. Missing, disabled, ambiguous, or unusable skills stop routing; never silently substitute the default. Guidance supplements the selected method. Explicit model/effort selections and verified Complexity remain authoritative. These instructions grant no lifecycle or publication authority.';
