import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

describe('scripts/aimock-server embedding authentication', () => {
  it('should require the fixture credential without exposing it in responses or proof', async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/aimock-server.ts',
        '--scenario',
        'openclaw-memory',
        '--port',
        '0',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    let errors = '';
    child.stderr.on('data', (data: Buffer) => {
      errors = (errors + data.toString()).slice(-4096);
    });
    try {
      const timeout = AbortSignal.timeout(5000);
      const [url] = await Promise.race([
        once(lines, 'line', { signal: timeout }),
        exited.then(() => {
          throw new Error(`Embedding fixture exited before readiness: ${errors}`);
        }),
      ]);
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:\d+$/u, errors);
      const body = JSON.stringify({
        model: 'text-embedding-3-small',
        input: ['fixture note', 'fixture query'],
      });
      const denied = await fetch(`${url}/v1/embeddings`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-credential' },
        signal: timeout,
      });
      assert.equal(denied.status, 401);
      assert.ok(!(await denied.text()).includes('wrong-credential'));
      const accepted = await fetch(`${url}/v1/embeddings`, {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer synthetic-memory-credential',
        },
        signal: timeout,
      });
      assert.equal(accepted.status, 200);
      const response = (await accepted.json()) as { data: Array<{ embedding: number[] }> };
      assert.deepEqual(
        response.data.map(({ embedding }) => embedding),
        [
          [1, 0, 0],
          [1, 0, 0],
        ],
      );
      const proof = await fetch(`${url}/proof/evidence`, { signal: timeout });
      assert.equal(proof.status, 200);
      const text = await proof.text();
      assert.deepEqual(JSON.parse(text).embeddingAuthentication, { accepted: 1, rejected: 1 });
      assert.ok(!text.includes('synthetic-memory-credential'));
      assert.equal(JSON.parse(text).strictMissCount, 0);
    } finally {
      lines.close();
      child.kill('SIGTERM');
      await exited;
    }
  });
});
