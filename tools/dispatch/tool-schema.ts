import { Type, type TProperties } from 'typebox';
import { assessmentSchema } from '../../agent/model-routing.ts';
import { assessmentResultSchema } from '../../agent/assessment-result.ts';

const id = Type.String({ pattern: '^[a-f0-9]{64}$' });
const object = <P extends TProperties>(properties: P) =>
  Type.Object(properties, { additionalProperties: false });
export const dispatchParameters = Type.Union([
  object({ action: Type.Literal('check') }),
  object({ action: Type.Literal('inspect') }),
  object({ action: Type.Literal('next') }),
  object({
    action: Type.Literal('prepare'),
    id,
    digest: id,
    assessment: assessmentSchema,
    title: Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9 -]{2,79}$' }),
    fallback: Type.Optional(Type.Literal('default')),
  }),
  object({ action: Type.Literal('reconcile'), id }),
  object({ action: Type.Literal('retry'), id }),
  object({ action: Type.Literal('context'), id }),
  object({
    action: Type.Literal('result'),
    id,
    result: assessmentResultSchema,
    previousResultDigest: Type.Optional(id),
  }),
]);
