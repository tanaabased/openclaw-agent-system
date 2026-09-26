import { Type } from 'typebox';

export const doctorParameters = Type.Object(
  {
    timeoutMs: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 600_000,
        description:
          'Pass 600000 for the ten-minute OpenClaw-hosted Codex tool-call budget. Does not extend approval or setup-command deadlines.',
      }),
    ),
  },
  { additionalProperties: false },
);
