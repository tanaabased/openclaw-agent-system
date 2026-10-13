import { Type, type Static } from 'typebox';

export const defaultAssessmentSkill = 'agent-system:agent-system-issue-assessment';
export const maximumAssessmentGuidanceBytes = 32 * 1024;
const assessmentSkillIdPattern =
  '^[ \\t]*\\$?[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?[ \\t]*$';
const assessmentSkillId = new RegExp(assessmentSkillIdPattern, 'u');

export function normalizeAssessmentSkillId(value: string): string {
  if (value.length > 256 || !assessmentSkillId.test(value))
    throw new Error('dispatch-assessment-skill-id-invalid');
  return value.trim().replace(/^\$/u, '');
}

export const assessmentConfigurationSchema = Type.Object(
  {
    skill: Type.Optional(Type.String({ maxLength: 256, pattern: assessmentSkillIdPattern })),
    guidance: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1, maxLength: maximumAssessmentGuidanceBytes, pattern: '\\S' }),
        Type.Object(
          { file: Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }) },
          { additionalProperties: false },
        ),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type AssessmentConfiguration = Static<typeof assessmentConfigurationSchema>;

export function decodeAssessmentConfiguration(
  value: AssessmentConfiguration,
): AssessmentConfiguration {
  return {
    ...(value.skill === undefined ? {} : { skill: normalizeAssessmentSkillId(value.skill) }),
    ...(value.guidance === undefined ? {} : { guidance: value.guidance }),
  };
}
