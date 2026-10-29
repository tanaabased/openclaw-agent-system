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

  it('should retain independent default tails and exact loss counts after large output', async () => {
    const result = await runCodexSetupProcess(
      [
        process.execPath,
        '-e',
        'process.stdout.write("x".repeat(600000) + "OUT"); process.stderr.write("y".repeat(600000) + "ERR"); process.exitCode = 17',
      ],
      options({
        maxOutputBytes: undefined,
        maxCombinedOutputBytes: undefined,
        outputCapture: undefined,
      }),
    );
    assert.equal(result.code, 17);
    assert.equal(Buffer.byteLength(result.stdout), 512 * 1024);
    assert.equal(Buffer.byteLength(result.stderr), 512 * 1024);
    assert.ok(result.stdout.endsWith('OUT'));
    assert.ok(result.stderr.endsWith('ERR'));
    assert.equal(result.stdoutTruncatedBytes, 75715);
    assert.equal(result.stderrTruncatedBytes, 75715);
  });

  it('should honor explicit tail and combined budgets', async () => {
    const result = await runCodexSetupProcess(
      [process.execPath, '-e', 'process.stdout.write("abcdefghijkl")'],
      options({ outputCapture: 'tail', maxCombinedOutputBytes: 8 }),
    );
    assert.equal(result.stdout, 'efghijkl');
    assert.equal(result.stdoutTruncatedBytes, 4);
  });

  it('should preserve split unicode and discard only incomplete capture boundaries', async () => {
    for (const [mode, expected, lost] of [
      ['head', 'x€', 4],
      ['tail', '🦄', 4],
    ] as const) {
      const result = await runCodexSetupProcess(
        [
          process.execPath,
          '-e',
          'const b = Buffer.from("x€🦄"); process.stdout.write(b.subarray(0, 3)); setImmediate(() => process.stdout.write(b.subarray(3)))',
        ],
        options({ outputCapture: mode, maxOutputBytes: 5, maxCombinedOutputBytes: undefined }),
      );
      assert.equal(result.stdout, expected);
      assert.equal(result.stdoutTruncatedBytes, lost);
      assert.ok(!result.stdout.includes('�'));
    }
    const complete = await runCodexSetupProcess(
      [
        process.execPath,
        '-e',
        'const b = Buffer.from("x€🦄"); process.stdout.write(b.subarray(0, 3)); setImmediate(() => process.stdout.write(b.subarray(3)))',
      ],
      options({ maxOutputBytes: 8, maxCombinedOutputBytes: undefined }),
    );
    assert.equal(complete.stdout, 'x€🦄');
    assert.equal(complete.stdoutTruncatedBytes, undefined);
  });

  it('should reject invalid explicit budgets before starting the child', async () => {
    for (const maxOutputBytes of [0, -1, NaN, Infinity, 1.5])
      await assert.rejects(
        runCodexSetupProcess(['/missing-executable'], options({ maxOutputBytes })),
        RangeError,
      );
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
