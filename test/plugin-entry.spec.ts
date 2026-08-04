import assert from 'node:assert/strict';

import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

import plugin from '../index.ts';
import type { CommandLike } from '../lib/register-cli.ts';

describe('index', () => {
  it('should expose the Agent System plugin contract', () => {
    assert.equal(plugin.id, 'agent-system');
    assert.equal(plugin.name, 'Agent System');
    assert.equal(typeof plugin.register, 'function');
    assert.equal(plugin.configSchema.jsonSchema?.additionalProperties, false);
    assert.deepEqual(plugin.configSchema.jsonSchema?.properties, {});
  });

  it('should register startup hooks and both CLI roots', () => {
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
    const logger = {
      debug() {},
      error() {},
      info() {},
      warn() {},
    };
    const api = {
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
    };

    plugin.register(api as never);

    assert.equal(typeof registrar, 'function');
    assert.deepEqual(hookNames, ['session_start', 'before_tool_call']);
    assert.deepEqual(options?.commands, ['agent-system', 'as']);
    assert.deepEqual(
      options?.descriptors?.map(({ hasSubcommands, name }) => ({ hasSubcommands, name })),
      [
        { hasSubcommands: true, name: 'agent-system' },
        { hasSubcommands: true, name: 'as' },
      ],
    );
  });
});
