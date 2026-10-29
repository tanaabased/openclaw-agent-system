import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';

import executeAutomation from '../cli/automation-execute.ts';
import type { SetupCommandResult } from '../agent/setup-runner.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import type { AutomationLifecycleCommandScope } from '../agent/automation-lifecycle-authority.ts';

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
    let authority: AutomationLifecycleCommandScope | undefined;
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
          async run(
            _command: unknown,
            target: { captureOutput?: boolean; automation?: AutomationLifecycleCommandScope },
          ) {
            retained = target.captureOutput === true;
            authority = target.automation;
            assert.ok(authority);
            await authority.assertCurrent();
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
      assert.ok(authority);
      assert.throws(() => authority!.assertActive());
      await assert.rejects(authority.assertCurrent());
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

  it('should forward long streams without clipping late errors or completion metadata', async () => {
    const stdout = '€'.repeat(400_000) + '\nlate stdout error';
    const stderr = 'x'.repeat(70_000) + '\nlate stderr error';
    const run = await execute({
      exitCode: 17,
      timedOut: false,
      truncated: false,
      termination: 'exit',
      signal: null,
      output: { stdout, stderr },
    });
    assert.equal(run.code, 17);
    assert.equal(run.stderr, stderr + '\n');
    assert.ok(run.stdout.startsWith(stdout + '\n'));
    const completion = JSON.parse(run.stdout.trimEnd().split('\n').at(-1)!);
    assert.deepEqual(completion, {
      id: 'job',
      status: 'error',
      code: 'automation-command-completed',
      exitCode: 17,
      termination: 'exit',
      signal: null,
      timedOut: false,
      cancelled: false,
      truncated: false,
      stdoutTruncatedBytes: 0,
      stderrTruncatedBytes: 0,
    });
  });

  it('should preserve exact native loss facts without inventing more truncation', async () => {
    const run = await execute({
      exitCode: 17,
      timedOut: false,
      truncated: true,
      termination: 'exit',
      output: {
        stdout: '€ late stdout',
        stderr: 'late stderr',
        stdoutTruncatedBytes: 21,
        stderrTruncatedBytes: 9,
      },
    });
    assert.ok(run.stdout.startsWith('€ late stdout\n[stdout truncated: 21 bytes]\n'));
    assert.equal(run.stderr, 'late stderr\n[stderr truncated: 9 bytes]\n');
    const completion = JSON.parse(run.stdout.trimEnd().split('\n').at(-1)!);
    assert.equal(completion.truncated, true);
    assert.equal(completion.stdoutTruncatedBytes, 21);
    assert.equal(completion.stderrTruncatedBytes, 9);
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
