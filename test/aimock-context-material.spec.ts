import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getTextContent, type ChatCompletionRequest } from '@copilotkit/aimock';

import implementationMaterial, {
  type ImplementationMaterialRead,
} from '../agent/implementation-material.ts';
import contextMaterialTransport from '../agent/context-material-transport.ts';
import contextMaterialExchange from '../scripts/aimock-context-material.ts';

describe('aimock context material', () => {
  it('should advance all pages when the host normalizes long tool call ids', () => {
    const source = { status: 'verified', instructions: 'Distinct reply context. '.repeat(1000) };
    const transport = { tool: 'agent_system_dispatch' };
    const input = { action: 'reply', operation: 'compose' };
    const initialId = 'call_notifications_context_fc-zexhi4gzCy-qDwcw_ec91c0';
    const request = {
      model: 'fixture',
      messages: [
        { role: 'user', content: 'Compose the reply.' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: initialId,
              type: 'function',
              function: { name: 'agent_system_dispatch', arguments: JSON.stringify(input) },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: initialId,
          content: JSON.stringify(
            contextMaterialTransport(implementationMaterial(source, input), transport),
          ),
        },
      ],
    } as ChatCompletionRequest;
    const offsets = new Set<number>();
    for (let attempt = 0; attempt < 20; attempt++) {
      const exchange = contextMaterialExchange(request);
      if (!exchange.pending) {
        assert.deepEqual(JSON.parse(getTextContent(exchange.request.messages[2]!.content)!), {
          ...source,
          materialTransport: transport,
        });
        assert.ok(offsets.size > 1);
        return;
      }
      assert.ok('toolCalls' in exchange.pending);
      const call = exchange.pending.toolCalls![0]!;
      const read = JSON.parse(call.arguments);
      assert.ok(!offsets.has(read.material.offset), 'must not request the same page again');
      offsets.add(read.material.offset);
      const framed = `${call.id}_fc-zexhi4gzCy-qDwcw_ec91c0`;
      const normalized =
        framed.length <= 64
          ? framed
          : `${framed.slice(0, 53)}_${createHash('sha256').update(framed).digest('hex').slice(0, 10)}`;
      request.messages.push(
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: normalized,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: normalized,
          content: JSON.stringify(
            contextMaterialTransport(
              implementationMaterial(source, input, read.material as ImplementationMaterialRead),
              transport,
            ),
          ),
        },
      );
    }
    assert.fail('context pages did not complete');
  });
});
