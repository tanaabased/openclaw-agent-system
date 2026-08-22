import assert from 'node:assert/strict';

import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

import plugin from '../index.ts';
import type { CommandLike } from '../cli/register.ts';
import githubNotificationCommentEventInstructions from '../channels/github/conversation/prompts/event-comment.ts';
import githubNotificationIssueLifecycleInstructions from '../channels/github/conversation/prompts/lifecycle-issue.ts';
import githubNotificationWorkModeInstructions from '../channels/github/conversation/prompts/mode-work.ts';
import githubNotificationResponseInstructions from '../channels/github/conversation/prompts/response.ts';

const currentGitHubTurnInstructions = [
  githubNotificationIssueLifecycleInstructions,
  githubNotificationWorkModeInstructions,
  githubNotificationCommentEventInstructions,
  githubNotificationResponseInstructions,
].join('\n\n');

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
    const hookHandlers = new Map<string, (...args: unknown[]) => unknown>();
    const channelIds: string[] = [];
    const commandNames: string[] = [];
    const policyIds: string[] = [];
    const serviceIds: string[] = [];
    const toolNames: string[] = [];
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

    plugin.register(api as never);

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
    assert.deepEqual(options?.commands, ['agent-system', 'as']);
    assert.deepEqual(
      options?.descriptors?.map(({ hasSubcommands, name }) => ({ hasSubcommands, name })),
      [
        { hasSubcommands: true, name: 'agent-system' },
        { hasSubcommands: true, name: 'as' },
      ],
    );

    const promptResult = (await hookHandlers.get('before_prompt_build')?.(
      {},
      { messageProvider: 'agent-system-github' },
    )) as { appendSystemContext?: string } | undefined;
    assert.deepEqual(promptResult, { appendSystemContext: currentGitHubTurnInstructions });
    assert.equal(currentGitHubTurnInstructions.match(/agent_system_github_reply/gu)?.length, 1);

    const unrelatedPromptResult = await hookHandlers.get('before_prompt_build')?.(
      {},
      { messageProvider: 'discord' },
    );
    assert.equal(unrelatedPromptResult, undefined);
  });
});
