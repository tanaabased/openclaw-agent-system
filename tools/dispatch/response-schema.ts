import { Type } from 'typebox';

export const responseRequestSchema = Type.Object(
  {
    action: Type.Literal('response'),
    blocks: Type.Optional(
      Type.Array(
        Type.Object(
          {
            section: Type.Optional(
              Type.Union([
                Type.Literal('assessment'),
                Type.Literal('assessment-reply'),
                Type.Literal('work'),
                Type.Literal('delivery'),
                Type.Literal('delivery-reply'),
                Type.Literal('debug'),
              ]),
            ),
            markdown: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
