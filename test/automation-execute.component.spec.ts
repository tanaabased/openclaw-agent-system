import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';

import executeAutomation from '../cli/automation-execute.ts';
import type { SetupCommandResult } from '../agent/setup-runner.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

describe('cli/automation-execute', () => {
  async function execute(result: SetupCommandResult) {
    const workspaceDir = await realpath(await mkdtemp('/tmp/automation-output-'));
    const loaded: AgentManifestLoadResult = {
      status: 'loaded',
      manifest: { schemaVersion: 1, agent: { id: 'a' } },
      scope: { workspaceDir, agentId: 'a' },
      path: `${workspaceDir}/agent.yaml`,
      digest: 'fixture',
      validationChecks: [],
      diagnostics: [],
    };
    let stdout = '';
    let stderr = '';
    let retained = false;
    try {
      const code = await executeAutomation({
        id: 'job',
        hash: 'a'.repeat(64),
        workspaceDir,
        manifestService: {
          loadForAgentId: async () => loaded,
          loadForCommandDirectory: async () => loaded,
        },
        automations: {
          admit: async () => ({
            command: { kind: 'exec', executable: 'true', args: [], timeoutSeconds: 10 },
            context: { agentId: 'a', workspaceDir },
          }),
        } as never,
        commands: {
          async run(_command: unknown, target: { captureOutput?: boolean }) {
            retained = target.captureOutput === true;
            return result;
          },
        } as never,
        output: {
          writeStdout: (text) => {
            stdout += text;
          },
          writeStderr: (text) => {
            stderr += text;
          },
        },
      });
      return { code, stdout, stderr, retained };
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  }

  it('should retain both command streams and the real failing exit status', async () => {
    const run = await execute({
      exitCode: 17,
      timedOut: false,
      truncated: false,
      termination: 'exit',
      output: { stdout: 'stdout-fixture-marker', stderr: 'stderr-fixture-marker' },
    });
    assert.equal(run.code, 17);
    assert.equal(run.retained, true);
    assert.ok(run.stdout.includes('stdout-fixture-marker'));
    assert.ok(!run.stdout.includes('stderr-fixture-marker'));
    assert.ok(run.stderr.includes('stderr-fixture-marker'));
  });

  it('should retain empty or single-stream successful output without inventing errors', async () => {
    for (const output of [
      { stdout: '', stderr: '' },
      { stdout: 'only output', stderr: '' },
      { stdout: '', stderr: 'only warning' },
    ]) {
      const run = await execute({
        exitCode: 0,
        timedOut: false,
        truncated: false,
        termination: 'exit',
        output,
      });
      assert.equal(run.code, 0);
      const completion = JSON.parse(run.stdout.trimEnd().split('\n').at(-1)!);
      assert.equal(completion.status, 'ok');
      assert.equal(completion.truncated, false);
      if (output.stdout) assert.ok(run.stdout.startsWith(output.stdout));
      assert.equal(run.stderr, output.stderr ? `${output.stderr}\n` : '');
    }
  });

  it('should bound both streams by bytes and retain inner and outer truncation signals', async () => {
    const run = await execute({
      exitCode: 17,
      timedOut: false,
      truncated: true,
      termination: 'exit',
      output: { stdout: '€'.repeat(10_000), stderr: 'stderr-marker', stderrTruncatedBytes: 9 },
    });
    assert.equal(run.code, 17);
    assert.ok(Buffer.byteLength(run.stdout) + Buffer.byteLength(run.stderr) < 16_384);
    assert.ok(!run.stdout.includes('\ufffd'));
    assert.ok(run.stdout.includes('[stdout truncated]'));
    assert.ok(run.stderr.includes('stderr-marker\n[stderr truncated]'));
    assert.equal(JSON.parse(run.stdout.trimEnd().split('\n').at(-1)!).truncated, true);
  });

  it('should not report success for timeout signal or missing exit even with misleading zero status', async () => {
    for (const result of [
      { exitCode: 0, timedOut: true, termination: 'timeout' as const },
      { exitCode: 0, timedOut: false, termination: 'signal' as const, signal: 'SIGTERM' },
      { exitCode: null, timedOut: false, termination: 'exit' as const },
    ]) {
      const run = await execute({
        ...result,
        truncated: false,
        output: { stdout: 'failure output', stderr: '' },
      });
      assert.equal(run.code, 1);
      const completion = JSON.parse(run.stdout.trimEnd().split('\n').at(-1)!);
      assert.equal(completion.status, 'error');
      assert.equal(completion.termination, result.termination);
      assert.ok(run.stdout.includes('failure output'));
    }
  });

  it('should abort bound execution on termination and remove its signal handlers', async () => {
    const workspaceDir = await realpath(await mkdtemp('/tmp/automation-execute-'));
    const loaded: AgentManifestLoadResult = {
      status: 'loaded',
      manifest: { schemaVersion: 1, agent: { id: 'a' } },
      scope: { workspaceDir, agentId: 'a' },
      path: `${workspaceDir}/agent.yaml`,
      digest: 'fixture',
      validationChecks: [],
      diagnostics: [],
    };
    const before = process.listenerCount('SIGTERM');
    let output = '';
    let disposed = false;
    try {
      const code = await executeAutomation({
        id: 'job',
        hash: 'a'.repeat(64),
        workspaceDir,
        manifestService: {
          loadForAgentId: async () => loaded,
          loadForCommandDirectory: async () => loaded,
        },
        automations: {
          admit: async () => ({
            command: { kind: 'exec', executable: 'true', args: [], timeoutSeconds: 10 },
            context: { agentId: 'a', workspaceDir },
          }),
        } as never,
        commands: {
          async run(_command: unknown, target: { mode?: string }, signal: AbortSignal) {
            assert.equal(target.mode, undefined);
            process.emit('SIGTERM', 'SIGTERM');
            assert.equal(signal.aborted, true);
            disposed = true;
            return { exitCode: null, timedOut: false, truncated: false };
          },
        } as never,
        output: {
          writeStdout: (text) => {
            output += text;
          },
          writeStderr: () => assert.fail('unexpected stderr'),
        },
      });
      assert.equal(code, 1);
      assert.equal(disposed, true);
      assert.equal(JSON.parse(output).code, 'automation-cancelled');
      assert.equal(process.listenerCount('SIGTERM'), before);
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
