import { Type } from 'typebox';

export const codexNoticeLimit = 100;
// accepted only when reading pre-summary journals; readers discard these fields.
export const codexNoticeSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-f0-9]{64}$' }),
    message: Type.String({ minLength: 1, maxLength: 32000 }),
    notify: Type.Boolean(),
  },
  { additionalProperties: false },
);
