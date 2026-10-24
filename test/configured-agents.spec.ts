import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import configuredAgentEntries, { configuredAgentValue } from '../core/configured-agents.ts';

describe('core/configured-agents', () => {
  it('should read canonical keyed entries and retain their mutable source values', () => {
    const config: OpenClawConfig = {
      agents: {
        entries: {
          emori: { workspace: '/workspace/emori' },
          tanaabot: { workspace: '/workspace/tanaabot' },
        },
      },
    };

    assert.deepEqual(configuredAgentEntries(config), [
      { id: 'emori', workspace: '/workspace/emori' },
      { id: 'tanaabot', workspace: '/workspace/tanaabot' },
    ]);

    const value = configuredAgentValue(config, 'EMORI');
    assert.ok(value);
    value.workspace = '/workspace/updated';
    assert.equal(config.agents?.entries?.emori?.workspace, '/workspace/updated');
  });

  it('should retain mutable values from the validated list projection', () => {
    const projected = {
      agents: { defaults: {}, list: [{ id: 'EMORI', workspace: '/workspace/emori' }] },
    };

    assert.deepEqual(configuredAgentEntries(projected), projected.agents.list);
    const value = configuredAgentValue(projected, 'emori');
    assert.ok(value);
    value.workspace = '/workspace/updated';
    assert.equal(projected.agents.list[0]?.workspace, '/workspace/updated');
  });
});
