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
