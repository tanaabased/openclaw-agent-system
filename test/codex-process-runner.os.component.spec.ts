import assert from 'node:assert/strict';

import runCodexSetupProcess from '../agent/codex-process-runner.ts';

function options(overrides: Partial<Parameters<typeof runCodexSetupProcess>[1]> = {}) {
  return {
    baseEnv: {},
    cwd: process.cwd(),
    env: {},
    input: '',
    killGraceMs: 20,
    killProcessTree: true,
    maxCombinedOutputBytes: 12,
    maxOutputBytes: 10,
    outputCapture: 'head' as const,
    timeoutMs: 1_000,
    ...overrides,
  };
}

describe('agent/codex-process-runner', () => {
  for (const reason of ['timeout', 'signal'] as const) {
    it(`should honor ${reason} after the parent exits with inherited pipes still open`, async function () {
      this.timeout(5_000);
      const controller = new AbortController();
      const descendant =
        'process.on("SIGTERM", () => {}); setTimeout(() => process.stdout.write("survived"), 1500)';
      const abort = reason === 'signal' ? setTimeout(() => controller.abort(), 500) : undefined;
      try {
        const result = await runCodexSetupProcess(
          [
            process.execPath,
            '-e',
            `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", 1, 2] }).unref(); process.exit(0)`,
          ],
          options({ signal: controller.signal, timeoutMs: reason === 'timeout' ? 500 : 3_000 }),
        );

        assert.equal(result.code, null);
        assert.equal(result.signal, null, 'the direct parent must have exited before termination');
        assert.equal(result.killed, true);
        assert.equal(result.termination, reason);
        assert.equal(result.stdout, '', 'the descendant must be killed before its final output');
      } finally {
        clearTimeout(abort);
      }
    });
  }

  it('should preserve exit status while bounding captured output', async () => {
    const result = await runCodexSetupProcess(
      [process.execPath, '-e', 'process.stdout.write("abcdefghijkl"); process.stderr.write("xyz")'],
      options(),
    );

    assert.equal(result.code, 0);
    assert.equal(result.termination, 'exit');
    assert.equal(result.stdout, 'abcdefghij');
    assert.equal(result.stderr, 'xy');
    assert.equal(result.stdoutTruncatedBytes, 2);
    assert.equal(result.stderrTruncatedBytes, 1);
  });

  it('should tolerate a child closing stdin before input is consumed', async () => {
    const result = await runCodexSetupProcess(
      [process.execPath, '-e', 'process.exit(0)'],
      options({ input: 'x'.repeat(1_048_576) }),
    );

    assert.equal(result.code, 0);
    assert.equal(result.termination, 'exit');
  });

  it('should terminate a timed out process group', async () => {
    const result = await runCodexSetupProcess(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      options({ timeoutMs: 20 }),
    );

    assert.equal(result.code, null);
    assert.equal(result.killed, true);
    assert.equal(result.termination, 'timeout');
    assert.ok(result.signal === 'SIGTERM' || result.signal === 'SIGKILL');
  });

  it('should forward cancellation to the process group', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await runCodexSetupProcess(
      [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
      options({ signal: controller.signal }),
    );

    assert.equal(result.code, null);
    assert.equal(result.killed, true);
    assert.equal(result.termination, 'signal');
  });
});
