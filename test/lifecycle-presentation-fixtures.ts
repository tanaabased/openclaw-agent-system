import type {
  AgentSystemLifecycleFinding,
  AgentSystemLifecycleOutcome,
} from '../core/lifecycle-registry.ts';

// Synthetic results for regression checks and terminal captures, not a host diagnosis.
export const doctorFindings: AgentSystemLifecycleFinding[] = [
  {
    code: 'agent-ready',
    component: 'agent',
    message: 'Registration and identity match the manifest.',
    status: 'healthy',
  },
  {
    code: 'security-warning',
    component: 'security',
    message: 'This agent may reach operator command surfaces.',
    remediation: 'Use native tools and restrict generic execution.',
    status: 'warning',
  },
  {
    code: 'git-blocked',
    component: 'git',
    message: 'Git SSH allowed signers file is missing.',
    remediation:
      'Restore the configured file before retrying. Keep the full remediation available even when the terminal is narrow.',
    status: 'blocked',
  },
  {
    code: 'notifications-manual',
    component: 'github-notifications',
    message: 'Manual follow-up is required.',
    status: 'manual',
  },
  {
    code: 'path-drift',
    component: 'path',
    message: 'Executable path projection differs from the manifest.',
    remediation: 'Run openclaw agent-system install from this workspace.',
    status: 'drift',
  },
  {
    code: 'github-blocked',
    component: 'github',
    message: 'GitHub CLI configuration is missing.',
    status: 'blocked',
  },
  {
    code: 'access-ready',
    component: 'tool-access',
    message: 'Tool access matches the manifest.',
    status: 'healthy',
  },
];

export const installOutcomes: AgentSystemLifecycleOutcome[] = [
  {
    code: 'agent-unchanged',
    component: 'agent',
    message: 'OpenClaw registration and identity match the manifest.',
    status: 'unchanged',
  },
  {
    code: 'path-updated',
    component: 'path',
    message: 'Executable path projection updated.',
    status: 'updated',
  },
  {
    code: 'git-created',
    component: 'git',
    message: 'Git worktree managed roots created.',
    status: 'created',
  },
  {
    code: 'path-removed',
    component: 'path',
    message: 'Stale owned path projection removed.',
    status: 'removed',
  },
  {
    code: 'github-unchanged',
    component: 'github',
    message: 'Private GitHub CLI config matches the manifest.',
    status: 'unchanged',
  },
];
