import { Type, type Static } from 'typebox';

import {
  assessmentConfigurationSchema,
  decodeAssessmentConfiguration,
  type AssessmentConfiguration,
} from './assessment-schema.ts';

export type AgentModelEffort = 'high' | 'medium' | 'xhigh';

export interface AgentModelProfile {
  effort: AgentModelEffort;
  model: string;
}

export interface AgentModelsConfiguration {
  default: AgentModelProfile;
  high?: AgentModelProfile;
  low?: AgentModelProfile;
  medium?: AgentModelProfile;
  routing?: AssessmentConfiguration;
}

export const modelReferenceSchema = Type.String({ pattern: '^[^/@\\s]+/[^@\\s]+$' });
export const explicitModelEfforts = [
  'none',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'adaptive',
  'max',
  'ultra',
] as const;

const externalAgentModelProfileSchema = Type.Object(
  {
    model: modelReferenceSchema,
    effort: Type.Union([Type.Literal('medium'), Type.Literal('high'), Type.Literal('xhigh')]),
  },
  { additionalProperties: false },
);

export const externalAgentModelsSchema = Type.Object(
  {
    default: externalAgentModelProfileSchema,
    low: Type.Optional(externalAgentModelProfileSchema),
    medium: Type.Optional(externalAgentModelProfileSchema),
    high: Type.Optional(externalAgentModelProfileSchema),
    routing: Type.Optional(assessmentConfigurationSchema),
  },
  { additionalProperties: false },
);

type ExternalAgentModels = Static<typeof externalAgentModelsSchema>;

function decodeProfile(profile: Static<typeof externalAgentModelProfileSchema>): AgentModelProfile {
  return { model: profile.model, effort: profile.effort };
}

export function decodeAgentModels(models: ExternalAgentModels): AgentModelsConfiguration {
  return {
    default: decodeProfile(models.default),
    ...(models.low === undefined ? {} : { low: decodeProfile(models.low) }),
    ...(models.medium === undefined ? {} : { medium: decodeProfile(models.medium) }),
    ...(models.high === undefined ? {} : { high: decodeProfile(models.high) }),
    ...(models.routing === undefined
      ? {}
      : { routing: decodeAssessmentConfiguration(models.routing) }),
  };
}
