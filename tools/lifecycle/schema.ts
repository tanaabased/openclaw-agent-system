import { Type } from 'typebox';

export const lifecycleToolNames = ['agent_system_install', 'agent_system_doctor'] as const;
export type LifecycleToolName = (typeof lifecycleToolNames)[number];

export const installParameters = Type.Object(
  {
    rebuildCodexPath: Type.Optional(Type.Boolean()),
    skipSetup: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const doctorParameters = Type.Object({}, { additionalProperties: false });

export function lifecycleParameters(name: LifecycleToolName) {
  return name === 'agent_system_install' ? installParameters : doctorParameters;
}
