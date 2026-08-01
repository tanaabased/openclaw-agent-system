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

  it('should register both CLI roots for lazy loading', () => {
    let registrar:
      | ((context: { logger: PluginLogger; program: CommandLike }) => Promise<void> | void)
      | undefined;
    let options:
      | {
          commands?: string[];
          descriptors?: Array<{ hasSubcommands?: boolean; name: string }>;
        }
      | undefined;
    const api = {
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
    assert.deepEqual(options?.commands, ['agent-system', 'as']);
    assert.deepEqual(
      options?.descriptors?.map(({ hasSubcommands, name }) => ({ hasSubcommands, name })),
      [
        { hasSubcommands: false, name: 'agent-system' },
        { hasSubcommands: false, name: 'as' },
      ],
    );
  });
});
