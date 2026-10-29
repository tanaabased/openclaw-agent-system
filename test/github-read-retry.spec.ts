import assert from 'node:assert/strict';

import type { AgentSystemCliResult } from '../api/types.ts';
import retryGitHubRead from '../core/github-read-retry.ts';

const reply = (status: number): AgentSystemCliResult => ({
  exitCode: status >= 400 ? 1 : 0,
  stdout: `HTTP/2 ${status} Response\n\n{}`,
  stderr: '',
  timedOut: false,
  truncated: false,
});

describe('github read retry', () => {
  it('should bound transient read attempts and share the original deadline', async () => {
    let clock = 0;
    const timeouts: number[] = [];
    const delays: number[] = [];
    const result = await retryGitHubRead(
      async (timeoutMs) => {
        timeouts.push(timeoutMs);
        clock += 100;
        return reply(timeouts.length < 3 ? 502 : 200);
      },
      {
        timeoutMs: 3000,
        now: () => clock,
        sleep: async (ms) => {
          delays.push(ms);
          clock += ms;
        },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.deepEqual(delays, [250, 1000]);
    assert.deepEqual(timeouts, [3000, 2650, 1550]);
  });

  it('should retain the final provider failure after three attempts', async () => {
    let calls = 0;
    const failure = reply(503);
    const result = await retryGitHubRead(
      async () => {
        calls++;
        return failure;
      },
      { sleep: async () => undefined },
    );
    assert.equal(calls, 3);
    assert.equal(result.stdout, failure.stdout);
    assert.match(result.stderr, /attempts=3 httpStatus=503/u);
    assert.equal(result.exitCode, 1);
  });

  it('should honor provider retry timing within the budget and preserve execution exceptions', async () => {
    let clock = 0;
    let calls = 0;
    const delays: number[] = [];
    await retryGitHubRead(
      async () =>
        ++calls === 1
          ? { ...reply(503), stdout: 'HTTP/2 503 Unavailable\nretry-after: 2\n\n{}' }
          : reply(200),
      {
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          delays.push(ms);
        },
      },
    );
    assert.deepEqual(delays, [2000]);
    calls = 0;
    const failure = new Error('executable unavailable');
    await assert.rejects(
      retryGitHubRead(async () => {
        calls++;
        throw failure;
      }),
      (error) => error === failure,
    );
    assert.equal(calls, 1);
  });

  it('should stop on denials invalid data truncation timeout and unknown errors', async () => {
    for (const failure of [
      ...[401, 403, 404, 429, 500, 422].map(reply),
      { ...reply(502), timedOut: true },
      { ...reply(502), truncated: true },
      { ...reply(502), stdoutTruncatedBytes: 1 },
      { ...reply(502), stderrTruncatedBytes: 1 },
      { ...reply(502), signal: 'SIGTERM' },
      { ...reply(200), stdout: 'invalid JSON' },
      { ...reply(200), exitCode: 1, stderr: 'unknown error', stdout: '' },
    ]) {
      let calls = 0;
      assert.equal(
        await retryGitHubRead(async () => {
          calls++;
          return failure;
        }),
        failure,
      );
      assert.equal(calls, 1);
    }
  });

  it('should retry only recognized interrupted read and graphql server errors', async () => {
    for (const stderr of [
      'unexpected end of JSON input',
      'ECONNRESET',
      'GraphQL: Something went wrong while executing your query',
    ]) {
      let calls = 0;
      const result = await retryGitHubRead(
        async () =>
          ++calls === 1 ? { ...reply(200), exitCode: 1, stdout: '', stderr } : reply(200),
        { sleep: async () => undefined },
      );
      assert.equal(calls, 2);
      assert.equal(result.exitCode, 0);
    }
  });

  it('should preserve cancellation and never restart after its budget expires', async () => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(
      retryGitHubRead(
        async () => {
          calls++;
          return reply(502);
        },
        {
          signal: controller.signal,
          sleep: async () => {
            controller.abort();
          },
        },
      ),
      { name: 'AbortError' },
    );
    assert.equal(calls, 1);
    let clock = 0;
    await retryGitHubRead(
      async () => {
        calls++;
        return reply(502);
      },
      {
        timeoutMs: 1000,
        now: () => clock,
        sleep: async () => {
          clock += 1001;
        },
      },
    );
    assert.equal(calls, 2);
  });
});
