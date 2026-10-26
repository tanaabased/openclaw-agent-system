import assert from 'node:assert/strict';

import runCredentialCommand from '../credentials/run-command.ts';

describe('credentials/run-command', () => {
  it('should send credential input through stdin without adding it to arguments', async () => {
    const token = 'private-token';
    const script =
      "let value='';process.stdin.on('data',chunk=>value+=chunk);process.stdin.on('end',()=>process.stdout.write(value))";
    const result = await runCredentialCommand({
      args: ['-e', script],
      command: process.execPath,
      input: token,
      maximumOutputBytes: 1024,
      timeoutMs: 1_000,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.toString(), token);
    assert.equal(['-e', script].includes(token), false);
  });

  it('should terminate a command that exceeds its timeout', async () => {
    const result = await runCredentialCommand({
      args: ['-e', 'setTimeout(()=>{},10000)'],
      command: process.execPath,
      maximumOutputBytes: 1024,
      timeoutMs: 20,
    });

    assert.equal(result.status, 'timed-out');
  });
  for (const reason of ['timed-out', 'output-too-large'] as const) {
    it(`should stop descendants retaining output pipes after ${reason}`, async () => {
      const descendant = `${reason === 'output-too-large' ? 'process.stdout.write("x".repeat(2048));' : ''}
        setTimeout(() => process.stdout.write('survived'), 1500)`;
      const result = await runCredentialCommand({
        command: process.execPath,
        args: [
          '-e',
          `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 1, 2] }).unref(); process.exit(0)`,
        ],
        maximumOutputBytes: 1024,
        timeoutMs: 500,
      });
      assert.equal(result.status, reason);
      assert.equal(result.stdout.includes('survived'), false);
      assert.ok(result.stdout.length + result.stderr.length <= 1024);
    });
  }
});
