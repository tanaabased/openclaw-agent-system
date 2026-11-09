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
        'openclaw-pr-journey',
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
      assert.deepEqual(await healthy.json(), {
        scenario: 'openclaw-pr-journey',
        failed: false,
      });

      const exception = await fetch(`${url}/v1/responses`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer private-transport-token',
        },
        body: JSON.stringify({
          model: 'gpt-5.5',
          tools: ['tool_search', 'tool_call'].map((name) => ({ type: 'function', name })),
          input: [
            { role: 'user', content: 'private-user' },
            {
              type: 'function_call_output',
              call_id: 'call_aimock_discover_fixture',
              output: 'private-value …123 tokens truncated…',
            },
          ],
        }),
        signal: timeout,
      });
      assert.equal(exception.status, 500);
      await exception.text();
      for (const endpoint of ['diagnostics', 'evidence']) {
        const observed = await fetch(`${url}/proof/${endpoint}`, { signal: timeout });
        assert.equal(observed.status, 500);
        const report = (await observed.json()) as {
          failed: boolean;
          fixtureErrors: Array<{ name: string; toolResults: Array<{ truncated: boolean }> }>;
        };
        assert.equal(report.failed, true);
        assert.equal(report.fixtureErrors[0]!.name, 'SyntaxError');
        assert.equal(report.fixtureErrors[0]!.toolResults[0]!.truncated, true);
        assert.doesNotMatch(JSON.stringify(report), /private-/u);
      }

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
          assert.equal(report.requests[0].method, 'POST');
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
