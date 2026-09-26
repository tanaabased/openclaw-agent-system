import type AgentLifecycleApproval from '../../agent/lifecycle-approval.ts';
import createLifecycleTool from '../../agent/lifecycle-tool.ts';
import { doctorParameters } from './tool-schema.ts';

export default function createDoctorTool(approval: () => AgentLifecycleApproval) {
  return createLifecycleTool(
    {
      id: 'doctor',
      name: 'agent_system_doctor',
      label: 'Agent System Doctor',
      description:
        'Request chat approval, then inspect the active agent workspace and run manifest-defined checks. Does not apply repairs.',
      parameters: doctorParameters,
      guidance:
        'Use agent_system_doctor for the active agent with timeoutMs: 600000 so OpenClaw-hosted Codex allows up to ten minutes for the tool call. OpenClaw must obtain Allow once in chat before execution, including Doctor checks. Never use shell commands or --yes to bypass approval. Doctor reports findings without repairs.',
    },
    approval,
  );
}
