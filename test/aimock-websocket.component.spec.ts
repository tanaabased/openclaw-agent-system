import assert from 'node:assert/strict';
import { once } from 'node:events';
import { LLMock } from '@copilotkit/aimock';

describe('aimock native codex transport', () => {
  it('should deliver a fixture through a standards-compliant websocket client', async () => {
    // Codex uses Responses over WebSocket. Keep the pinned dependency patch covered
    // at that boundary: HTTP fixtures alone cannot detect a broken upgrade handshake.
    const mock = new LLMock({ host: '127.0.0.1', port: 0, strict: true, logLevel: 'warn' });
    mock.addFixture({
      match: { model: 'transport-probe' },
      response: { content: 'fixture complete' },
    });
    const base = await mock.start();
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/v1/responses`);
    const signal = AbortSignal.timeout(5000);
    try {
      await Promise.race([
        once(socket, 'open', { signal }),
        once(socket, 'error', { signal }).then(() => {
          throw new Error('AIMock WebSocket handshake failed');
        }),
      ]);
      const completed = new Promise<Record<string, unknown>>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        socket.addEventListener('error', () =>
          reject(new Error('AIMock WebSocket transport failed')),
        );
        socket.addEventListener('message', ({ data }) => {
          const event = JSON.parse(String(data));
          if (event.type === 'response.completed') resolve(event.response);
          if (event.type === 'error') reject(new Error(JSON.stringify(event.error)));
        });
      });
      socket.send(
        JSON.stringify({ type: 'response.create', model: 'transport-probe', input: 'hello' }),
      );
      const response = await completed;
      assert.equal(response.status, 'completed');
      const output = response.output as Array<{ content: Array<{ text: string }> }>;
      assert.deepEqual(
        output.flatMap(({ content }) => content.map(({ text }) => text)),
        ['fixture complete'],
      );
    } finally {
      socket.close();
      await mock.stop();
    }
  });
});
