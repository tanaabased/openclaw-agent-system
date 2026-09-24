import type AgentLifecycleApproval from '../../agent/lifecycle-approval.ts';
import createLifecycleTool from '../../agent/lifecycle-tool.ts';
import { installParameters } from './tool-schema.ts';

export default function createInstallTool(approval: () => AgentLifecycleApproval) {
  return createLifecycleTool(
    {
      id: 'install',
      name: 'agent_system_install',
      label: 'Agent System Install',
      description:
        'Request chat approval, then reconcile the active agent workspace from its manifest, including setup. Set rebuildCodexPath only to replace the saved Codex PATH baseline with this process environment. No agent or workspace override.',
      parameters: installParameters,
      guidance:
        'Use agent_system_install for the active agent. OpenClaw must obtain Allow once in chat before execution. Never use shell commands or --yes to bypass approval.',
    },
    approval,
  );
}
