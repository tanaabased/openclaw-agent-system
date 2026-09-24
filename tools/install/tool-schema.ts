import { Type } from 'typebox';

export const installParameters = Type.Object(
  {
    rebuildCodexPath: Type.Optional(Type.Boolean()),
    skipSetup: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
