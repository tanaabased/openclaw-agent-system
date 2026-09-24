import { installParameters } from '../tools/install/tool-schema.ts';
import { doctorParameters } from '../tools/doctor/tool-schema.ts';

export const lifecycleToolNames = ['agent_system_install', 'agent_system_doctor'] as const;
export type LifecycleToolName = (typeof lifecycleToolNames)[number];

export function lifecycleParameters(name: LifecycleToolName) {
  return name === 'agent_system_install' ? installParameters : doctorParameters;
}
