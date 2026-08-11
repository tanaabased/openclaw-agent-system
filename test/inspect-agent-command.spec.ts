import assert from 'node:assert/strict';

import inspectAgentCommand from '../utils/inspect-agent-command.ts';

describe('utils/inspect-agent-command', () => {
  it('should ignore tools that are not command runners', () => {
    assert.deepEqual(inspectAgentCommand('agent_system_git', { argv: ['status'] }), {
      operatorInvocations: [],
      status: 'irrelevant',
    });
  });

  it('should identify an agent system tool command and its native route', () => {
    const result = inspectAgentCommand('exec', {
      command: 'exec env OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api user',
    });

    assert.deepEqual(result.operatorInvocations, [
      {
        recommendedTool: 'agent_system_github',
        surface: 'tool',
        targetAgentDynamic: false,
      },
    ]);
  });

  it('should identify a cross-agent selector in a compound command', () => {
    const result = inspectAgentCommand('exec_command', {
      cmd: 'printf ready; env NO_COLOR=1 openclaw as tool git --agent emori -- status',
      workdir: '/workspace/tanaabot',
    });

    assert.deepEqual(result, {
      cwd: '/workspace/tanaabot',
      operatorInvocations: [
        {
          recommendedTool: 'agent_system_git',
          surface: 'tool',
          targetAgentDynamic: false,
          targetAgentId: 'emori',
        },
      ],
      status: 'command',
    });
  });

  it('should treat dynamic credential selectors as cross-agent risks', () => {
    const result = inspectAgentCommand('exec', {
      command: 'openclaw agent-system credentials validate op --agent "$OTHER_AGENT"',
    });

    assert.deepEqual(result.operatorInvocations, [
      {
        surface: 'credentials',
        targetAgentDynamic: true,
      },
    ]);
  });

  it('should not treat child arguments after the delimiter as agent selectors', () => {
    const result = inspectAgentCommand('exec', {
      command: 'openclaw agent-system tool gh -- api repos/example --agent emori',
    });

    assert.deepEqual(result.operatorInvocations, [
      {
        recommendedTool: 'agent_system_github',
        surface: 'tool',
        targetAgentDynamic: false,
      },
    ]);
  });

  it('should identify an explicit managed shim path', () => {
    const result = inspectAgentCommand(
      'exec',
      { command: '../managed/gh api user', cwd: '/workspace/source' },
      { managedExecutableDirectories: ['/workspace/managed'] },
    );

    assert.deepEqual(result.operatorInvocations, [
      {
        recommendedTool: 'agent_system_github',
        surface: 'shim',
        targetAgentDynamic: false,
      },
    ]);
  });

  it('should not treat command text passed to another executable as an invocation', () => {
    const result = inspectAgentCommand('exec', {
      command: "printf '%s' 'openclaw agent-system tool gh -- api user'",
    });

    assert.deepEqual(result.operatorInvocations, []);
  });
});
