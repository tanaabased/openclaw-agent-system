import { Value } from 'typebox/value';

import { assessmentResultSchema, type AssessmentResult } from './assessment-result.ts';

interface AssessmentResultDiagnostic {
  valid: boolean;
  code?: string;
  outcomes?: AssessmentResult['outcome'][];
  outcome?: AssessmentResult['outcome'];
  requiredFields?: string[];
  allowedFields?: string[];
  missingFields?: string[];
  invalidFields?: string[];
  unexpectedFields?: string[];
  exceedsSizeLimit?: boolean;
  instruction: string;
}

/** explain the selected outcome without echoing assessment content or changing stored state. */
export default function assessmentResultDiagnostic(value: unknown): AssessmentResultDiagnostic {
  const variants = assessmentResultSchema.anyOf;
  const outcomes = variants.map((schema) => schema.properties.outcome.const);
  const candidate =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const schema = variants.find((entry) => entry.properties.outcome.const === candidate?.outcome);
  if (!candidate || !schema)
    return {
      valid: false,
      code: 'assessment-result-invalid',
      outcomes,
      instruction: 'Supply one object with a supported outcome; preserve the complete assessment.',
    };
  const allowedFields = Object.keys(schema.properties);
  const knownFields = new Set(variants.flatMap((entry) => Object.keys(entry.properties)));
  const requiredFields = schema.required ?? [];
  const missingFields = requiredFields.filter((key) => !Object.hasOwn(candidate, key));
  const invalidFields = Object.entries(schema.properties)
    .filter(
      ([key, property]) => Object.hasOwn(candidate, key) && !Value.Check(property, candidate[key]),
    )
    .map(([key]) => key);
  const unexpectedFields = [
    ...new Set(
      Object.keys(candidate)
        .filter((key) => !allowedFields.includes(key))
        .map((key) => (knownFields.has(key) ? key : '<unknown field>')),
    ),
  ];
  const exceedsSizeLimit = JSON.stringify(value).length > 96000;
  const valid = Value.Check(schema, value) && !exceedsSizeLimit;
  return {
    valid,
    ...(valid ? {} : { code: 'assessment-result-invalid' }),
    outcome: schema.properties.outcome.const,
    requiredFields,
    allowedFields,
    missingFields,
    invalidFields,
    unexpectedFields,
    exceedsSizeLimit,
    instruction: valid
      ? 'Valid candidate only; submit action result to record it.'
      : 'Correct these fields against resultSchema for this outcome, preserve substantive content, then submit action result. Do not truncate or claim recording.',
  };
}
