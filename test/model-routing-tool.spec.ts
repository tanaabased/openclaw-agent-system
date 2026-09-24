import assert from 'node:assert/strict';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import createModelRoutingTool from '../tools/model-routing/tool.ts';

function fixture() {
  const loaded = {
    status: 'loaded',
    digest: 'bound-digest',
    scope: { workspaceDir: '/bound' },
    manifest: {
      schemaVersion: 1,
      agent: { id: 'bound' },
      models: { default: { model: 'openai/bound', effort: 'medium' } },
      environment: { set: { SECRET: { fromOp: 'op://unavailable/item/secret' } } },
    },
  };
  const ids: string[] = [];
  const definition = createModelRoutingTool({
    async loadForAgentId(id) {
      ids.push(id);
      return loaded as never;
    },
    async loadForCommandDirectory() {
      throw new Error('task-directory discovery is forbidden');
    },
  });
  let factory: Parameters<OpenClawPluginApi['registerTool']>[0] | undefined;
  definition.registerTools(
    {
      registerTool(value) {
        factory = value;
      },
    },
    {} as never,
  );
  if (typeof factory !== 'function') throw new Error('missing native factory');
  return { loaded, ids, factory };
}

describe('native model routing tool', () => {
  it('should use trusted active-agent profiles without resolving an environment or mutating sessions', async () => {
    const f = fixture();
    const tool = await f.factory({ agentId: 'bound', workspaceDir: '/bound' });
    assert.ok(tool && !Array.isArray(tool));
    const result = await tool.execute('call', {
      action: 'resolve',
      manifestDigest: 'bound-digest',
      context: 'An underspecified task in another repository.',
      assessment: { complexity: 'unset', reason: 'No defensible tier.' },
      fallback: 'default',
    });
    assert.deepEqual(f.ids, ['bound']);
    const block = result.content[0];
    assert.ok(block?.type === 'text');
    const data = JSON.parse(block.text);
    assert.equal(data.status, 'unresolved');
    assert.deepEqual(data.selection, f.loaded.manifest.models.default);
    assert.equal(data.application, 'not-requested');
    assert.equal(block.text.includes('SECRET'), false);
  });

  it('should reject missing or mismatched active workspace authority and model-chosen workspace fields', async () => {
    for (const context of [{}, { agentId: 'bound', workspaceDir: '/other' }]) {
      const f = fixture();
      const tool = await f.factory(context);
      assert.ok(tool && !Array.isArray(tool));
      await assert.rejects(
        tool.execute('call', { action: 'inspect' }),
        /active OpenClaw agent|bind the active/,
      );
    }
    const f = fixture();
    const tool = await f.factory({ agentId: 'bound', workspaceDir: '/bound' });
    assert.ok(tool && !Array.isArray(tool));
    await assert.rejects(
      tool.execute('call', { action: 'inspect', workspace: '/other' }),
      /Unknown fields/,
    );
  });
});
