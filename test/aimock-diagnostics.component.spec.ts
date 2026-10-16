import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('scripts/aimock-server diagnostics', () => {
  it('should expose a strict miss through curl failure output and still stop cleanly', async () => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/aimock-server.ts',
        '--scenario',
        'openclaw-notifications',
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
          throw new Error(`AIMock exited before readiness: ${errors}`);
        }),
      ]);
      assert.match(String(url), /^http:\/\/127\.0\.0\.1:\d+$/u, errors);
      const healthy = await fetch(`${url}/proof/diagnostics`, { signal: timeout });
      assert.equal(healthy.status, 200);
      assert.deepEqual(await healthy.json(), { scenario: 'openclaw-notifications', failed: false });

      const missed = await fetch(`${url}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer private-transport-token',
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          messages: [
            { role: 'system', content: 'private-system' },
            { role: 'user', content: 'private-user' },
          ],
        }),
        signal: timeout,
      });
      assert.equal(missed.status, 503);
      await missed.text();
      await assert.rejects(
        execFileAsync('curl', [
          '--fail-with-body',
          '--silent',
          '--show-error',
          '--max-time',
          '5',
          `${url}/proof/diagnostics`,
        ]),
        (error: unknown) => {
          const failure = error as { code?: number; stdout?: string };
          assert.equal(failure.code, 22);
          const report = JSON.parse(failure.stdout ?? '');
          assert.equal(report.failed, true);
          assert.equal(report.requests[0].matched, false);
          assert.equal(report.requests[0].checks.model, true);
          assert.equal(report.requests[0].checks.systemPrompt, false);
          assert.doesNotMatch(failure.stdout ?? '', /private-/u);
          return true;
        },
      );
    } finally {
      lines.close();
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0, errors);
    }
  });
});
