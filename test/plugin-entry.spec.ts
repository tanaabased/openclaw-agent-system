import assert from 'node:assert/strict';

import { Command } from 'commander';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

import plugin from '../index.ts';
import registerAgentSystem from '../lib/register-agent-system.ts';
import type { CommandLike } from '../lib/register-cli.ts';

describe('index', () => {
  it('should expose the agent system plugin contract', () => {
    assert.equal(plugin.id, 'agent-system');
    assert.equal(plugin.name, 'Agent System');
    assert.equal(plugin.description, 'Better per-agent management for OpenClaw.');
    assert.equal(typeof plugin.register, 'function');
    assert.equal(plugin.configSchema.jsonSchema?.additionalProperties, false);
    assert.deepEqual(plugin.configSchema.jsonSchema?.properties, {});
  });

  it('should register startup hooks and both cli roots', async () => {
    let registrar:
      | ((context: { logger: PluginLogger; program: CommandLike }) => Promise<void> | void)
      | undefined;
    let options:
      | {
          commands?: string[];
          descriptors?: Array<{ hasSubcommands?: boolean; name: string }>;
        }
      | undefined;
    const hookNames: string[] = [];
    const channelIds: string[] = [];
    const commandNames: string[] = [];
    const policyIds: string[] = [];
    const serviceIds: string[] = [];
    const subsystems: string[] = [];
    const toolNames: string[] = [];
    let stderrRoutes = 0;
    const logger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };
    const api = {
      id: 'agent-system',
      logger,
      on(name: string) {
        hookNames.push(name);
      },
      runtime: {
        agent: {
          resolveAgentWorkspaceDir() {
            return '/workspace';
          },
        },
        channel: {
          reply: {
            dispatchReplyWithBufferedBlockDispatcher() {},
          },
          session: {
            async recordInboundSession() {},
          },
        },
        config: {
          current() {
            return {};
          },
        },
      },
      registerCli(
        nextRegistrar: (context: {
          logger: PluginLogger;
          program: CommandLike;
        }) => Promise<void> | void,
        nextOptions: {
          commands?: string[];
          descriptors?: Array<{ hasSubcommands?: boolean; name: string }>;
        },
      ) {
        registrar = nextRegistrar;
        options = nextOptions;
      },
      registerChannel(registration: { plugin?: { id: string }; id?: string }) {
        const id = registration.plugin?.id ?? registration.id;
        if (id) channelIds.push(id);
      },
      registerCommand(command: { name: string }) {
        commandNames.push(command.name);
      },
      registerService(service: { id: string }) {
        serviceIds.push(service.id);
      },
      registerTool(_tool: unknown, toolOptions?: { name?: string }) {
        if (toolOptions?.name) toolNames.push(toolOptions.name);
      },
      registerTrustedToolPolicy(policy: { id: string }) {
        policyIds.push(policy.id);
      },
    };

    registerAgentSystem(api as never, new URL('../index.ts', import.meta.url).href, {
      createSubsystemLogger(subsystem) {
        subsystems.push(subsystem);
        return logger;
      },
      routeLogsToStderr() {
        stderrRoutes += 1;
      },
    });

    assert.equal(typeof registrar, 'function');
    assert.deepEqual(hookNames, [
      'resolve_exec_env',
      'before_tool_call',
      'session_start',
      'before_prompt_build',
    ]);
    assert.deepEqual(channelIds, ['agent-system-github']);
    assert.deepEqual(commandNames, ['agent-system-progress']);
    assert.deepEqual(serviceIds, ['agent-system-command-authority']);
    assert.deepEqual(toolNames, [
      'agent_system_git',
      'agent_system_git_worktree',
      'agent_system_github',
    ]);
    assert.deepEqual(policyIds, [
      'agent-system.git',
      'agent-system.git-worktree',
      'agent-system.github',
    ]);
    assert.deepEqual(options?.commands, ['agent-system', 'as']);
    assert.deepEqual(subsystems, ['plugins/agent-system']);
    assert.equal(stderrRoutes, 0);
    assert.deepEqual(
      options?.descriptors?.map(({ hasSubcommands, name }) => ({ hasSubcommands, name })),
      [
        { hasSubcommands: true, name: 'agent-system' },
        { hasSubcommands: true, name: 'as' },
      ],
    );
    if (!registrar) assert.fail('Agent System CLI registrar was not captured.');
    await registrar({ logger, program: new Command() });
    assert.equal(stderrRoutes, 1);
  });
});
