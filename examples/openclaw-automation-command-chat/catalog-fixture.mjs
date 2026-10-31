import { mock } from 'node:test';

// preserve the canonical provider route; only its account catalog is synthetic.
const originalFetch = globalThis.fetch;
mock.method(globalThis, 'fetch', async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== 'api.openai.com') return originalFetch(input, init);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (url.href !== 'https://api.openai.com/v1/models' || method !== 'GET') {
    throw new Error('Unexpected OpenAI request: inference must use AIMock through Codex.');
  }
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  if (headers.get('authorization') !== 'Bearer agent-system-aimock-test') {
    return Response.json({ error: 'Synthetic catalog credential required.' }, { status: 401 });
  }
  return Response.json({
    object: 'list',
    data: [{ id: 'gpt-5.5', object: 'model', created: 0, owned_by: 'fixture' }],
  });
});
