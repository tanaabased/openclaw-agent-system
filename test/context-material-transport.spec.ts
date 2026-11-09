import assert from 'node:assert/strict';

import contextMaterialTransport from '../agent/context-material-transport.ts';
import codexRuntimeRequest from '../agent/codex-runtime-request.ts';
import implementationMaterial, {
  type ImplementationMaterialRead,
} from '../agent/implementation-material.ts';

describe('agent/context-material-transport', () => {
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should read every ${runtime} page using the returned transport and untouched request`, () => {
      const source = { runtime, instructions: 'distinct instruction\n'.repeat(500) };
      const envelope = { action: 'context', id: 'task' };
      const transport =
        runtime === 'codex'
          ? { argv: ['/node', '/runtime.js', 'continuation', 'context', '--plugin-data', '/data'] }
          : { tool: 'agent_system_dispatch' };
      const snapshot = implementationMaterial(source, envelope);
      const index = contextMaterialTransport(snapshot, transport);
      assert.deepEqual((index as { materialTransport: unknown }).materialTransport, transport);
      assert.ok('contextMaterials' in snapshot && snapshot.contextMaterials);
      const firstRequest = snapshot.contextMaterials.fields[0]!.request;
      let request: Record<string, unknown> | undefined = firstRequest;
      let text = '';
      while (request) {
        const delivered = JSON.parse(
          JSON.stringify(
            contextMaterialTransport(
              implementationMaterial(
                source,
                envelope,
                request.material as ImplementationMaterialRead,
              ),
              transport,
            ),
          ),
        );
        assert.deepEqual(delivered.materialTransport, transport);
        if ('argv' in transport) {
          const [, , route, ...args] = delivered.materialTransport.argv;
          assert.equal(route, 'continuation');
          assert.deepEqual(codexRuntimeRequest(route, args, request).request, request);
        } else assert.equal(delivered.materialTransport.tool, 'agent_system_dispatch');
        assert.ok(JSON.stringify(delivered).length < 12000);
        assert.equal(delivered.materialPage.offset, text.length);
        text += delivered.materialPage.text;
        request = delivered.next;
      }
      assert.equal(JSON.parse(text), source.instructions);
      assert.throws(
        () =>
          implementationMaterial(
            { ...source, instructions: source.instructions + 'changed' },
            envelope,
            firstRequest.material as ImplementationMaterialRead,
          ),
        /implementation-material-stale/,
      );
    });

  it('should leave nonpaged responses alone', () => {
    const result = { status: 'verified' };
    assert.equal(contextMaterialTransport(result, { tool: 'agent_system_dispatch' }), result);
  });
});
