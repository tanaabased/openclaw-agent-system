import { getRootOptionAwareCommandPath } from 'openclaw/plugin-sdk/cli-argv';

function toolOwnsStdout({ argv }: { argv: readonly string[]; stdoutIsTTY: boolean }): boolean {
  return getRootOptionAwareCommandPath(argv, 2)[1] === 'tool';
}

/** Describe command roots and stdout ownership before runtime capabilities are available. */
const agentSystemCliMetadata = {
  commands: ['agent-system', 'as'],
  descriptors: [
    {
      name: 'agent-system',
      description: 'Manage reproducible OpenClaw agent workspaces.',
      hasSubcommands: true,
      machineOutput: toolOwnsStdout,
    },
    {
      name: 'as',
      description: 'Alias for the Agent System command.',
      hasSubcommands: true,
      machineOutput: toolOwnsStdout,
    },
  ],
};

export default agentSystemCliMetadata;
