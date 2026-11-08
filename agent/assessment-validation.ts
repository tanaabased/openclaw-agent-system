import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';

/** expose schema-owned locations, never submitted values or unknown property names. */
export default class AssessmentValidationError extends Error {
  readonly recovery: { instruction: string; fields: string[] };

  constructor(
    readonly code: string,
    schema: TSchema,
    value: unknown,
    prefix: string,
  ) {
    const error = Value.Errors(schema, value)[0];
    const path = [prefix, ...(error?.instancePath.split('/').filter(Boolean) ?? [])].join('.');
    const fields =
      error?.keyword === 'required'
        ? error.params.requiredProperties.map((property) => `${path}.${property}`)
        : [path];
    const instruction =
      'Correct the listed fields against the supplied contract using existing findings; preserve the complete source and request destination. Make at most one corrective attempt for this mistake in the same native turn. Do not invent findings, truncate the source or restart the task.';
    super(`${code}: invalid or missing fields: ${fields.join(', ')}. ${instruction}`);
    this.recovery = { instruction, fields };
  }
}
