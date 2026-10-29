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
        'Reconcile the active agent workspace after chat approval or verified owned automation activation, including setup and the shared release-pinned Codex prerequisite. Existing conflicting shared versions are never replaced. Set rebuildCodexPath only to replace the saved Codex PATH baseline with this process environment. No agent or workspace override.',
      parameters: installParameters,
      guidance:
        'Use agent_system_install for the active agent with timeoutMs: 600000 so OpenClaw-hosted Codex allows up to ten minutes for the tool call. Interactive calls require native Allow once. Agent System verifies activated owned prompt automations without recurring chat approval; prompt text or a session name grants no authority. Never use shell commands or --yes to bypass approval.',
    },
    approval,
  );
}
