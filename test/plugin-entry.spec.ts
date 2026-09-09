import assert from 'node:assert/strict';

import type { OpenClawPluginApi, PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

import plugin from '../index.ts';
import agentSystemCliMetadata from '../cli/metadata.ts';
import type { CommandLike } from '../cli/register.ts';

describe('index', () => {
  it('should expose the agent system plugin contract', () => {
    assert.equal(plugin.id, 'agent-system');
    assert.equal(plugin.name, 'Agent System');
    assert.equal(plugin.description, 'Better per-agent management for OpenClaw.');
    assert.equal(typeof plugin.register, 'function');
    assert.equal(plugin.configSchema.jsonSchema?.additionalProperties, false);
    assert.deepEqual(plugin.configSchema.jsonSchema?.properties, {});
  });

  it('should declare cli output ownership without accessing runtime capabilities', () => {
    let runtimeAccessed = false;
    let metadata: Parameters<OpenClawPluginApi['registerCli']>[1];
    const api = {
      id: 'agent-system',
      registrationMode: 'cli-metadata',
      registerCli(_registrar: unknown, options: Parameters<OpenClawPluginApi['registerCli']>[1]) {
        metadata = options;
      },
      get runtime() {
        runtimeAccessed = true;
        throw new Error('runtime unavailable');
      },
    };

    assert.doesNotThrow(() => plugin.register(api as never));
    assert.equal(runtimeAccessed, false);
    assert.equal(metadata, agentSystemCliMetadata);
  });

  it('should register startup hooks and both cli roots', async () => {
    let registrar:
      | ((context: { logger: PluginLogger; program: CommandLike }) => Promise<void> | void)
      | undefined;
    let options: Parameters<OpenClawPluginApi['registerCli']>[1];
    const hookNames: string[] = [];
    const hookHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const channelIds: string[] = [];
    const commandNames: string[] = [];
    const policyIds: string[] = [];
    const serviceIds: string[] = [];
    const toolNames: string[] = [];
    let channelInboundDispatchAccessed = false;
    const logger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };
    const api = {
      id: 'agent-system',
      logger,
      on(name: string, handler: (...args: unknown[]) => unknown) {
        hookNames.push(name);
        hookHandlers.set(name, handler);
      },
      runtime: {
        agent: {
          resolveAgentWorkspaceDir() {
            return '/workspace';
          },
        },
        channel: {
          inbound: {
            get dispatch() {
              channelInboundDispatchAccessed = true;
              return async () => ({ dispatched: false });
            },
          },
        },
        config: {
          current() {
            return {};
          },
        },
        logging: {
          getChildLogger() {
            return logger;
          },
        },
        state: {
          resolveStateDir() {
            return '/openclaw';
          },
        },
      },
      registerCli(
        nextRegistrar: (context: {
          logger: PluginLogger;
          program: CommandLike;
        }) => Promise<void> | void,
        nextOptions: Parameters<OpenClawPluginApi['registerCli']>[1],
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

    plugin.register(api as never);

    assert.equal(channelInboundDispatchAccessed, true);
    assert.equal(typeof registrar, 'function');
    assert.deepEqual(hookNames, [
      'resolve_exec_env',
      'before_tool_call',
      'session_start',
      'before_prompt_build',
    ]);
    assert.deepEqual(channelIds, ['agent-system-github']);
    assert.deepEqual(commandNames, []);
    assert.deepEqual(serviceIds, ['agent-system-command-authority']);
    assert.deepEqual(toolNames, [
      'agent_system_git',
      'agent_system_git_worktree',
      'agent_system_github',
      'agent_system_github_reply',
    ]);
    assert.deepEqual(policyIds, [
      'agent-system.git',
      'agent-system.git-worktree',
      'agent-system.github',
    ]);
    assert.equal(options, agentSystemCliMetadata);
    assert.deepEqual(options?.commands, ['agent-system', 'as']);
    assert.deepEqual(
      options?.descriptors?.map(({ hasSubcommands, name }) => ({ hasSubcommands, name })),
      [
        { hasSubcommands: true, name: 'agent-system' },
        { hasSubcommands: true, name: 'as' },
      ],
    );

    for (const descriptor of options?.descriptors ?? []) {
      assert.ok('machineOutput' in descriptor && typeof descriptor.machineOutput === 'function');
      for (const argv of [
        ['node', 'openclaw', descriptor.name, 'tool', 'gh', '--', 'api', 'user'],
        [
          'node',
          'openclaw',
          '--profile',
          'tool',
          '--log-level',
          'debug',
          descriptor.name,
          'tool',
          'git',
          '--',
          'status',
        ],
      ]) {
        assert.equal(descriptor.machineOutput({ argv, stdoutIsTTY: false }), true);
        assert.equal(descriptor.machineOutput({ argv, stdoutIsTTY: true }), true);
      }
      assert.equal(
        descriptor.machineOutput({
          argv: ['node', 'openclaw', '--profile', 'tool', descriptor.name, 'doctor'],
          stdoutIsTTY: false,
        }),
        false,
      );
    }

    const promptResult = (await hookHandlers.get('before_prompt_build')?.(
      {},
      { messageProvider: 'agent-system-github' },
    )) as { appendSystemContext?: string } | undefined;
    assert.equal(promptResult, undefined);

    const unrelatedPromptResult = await hookHandlers.get('before_prompt_build')?.(
      {},
      { messageProvider: 'discord' },
    );
    assert.equal(unrelatedPromptResult, undefined);
  });
});
