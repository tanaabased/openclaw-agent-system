import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Run = (
  command: string,
  args: string[],
  input?: string,
) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

const runCommand: Run = (command, args, input) =>
  spawnSync(command, args, { encoding: 'utf8', input, timeout: 15_000, maxBuffer: 1024 * 1024 });

/** capture the first install before cleanup; diagnostics never retry the operation. */
export default function installEvidence(
  input: {
    exitCode: number;
    startedAt: string;
    stdoutPath: string;
    stderrPath: string;
    nativeLogPath: string;
    sourceDir: string;
    channelStatus?: boolean;
  },
  run: Run = runCommand,
  now = new Date(),
) {
  const sources: Record<string, { status: string; text?: string; truncated?: boolean }> = {};
  let redactor: string;
  try {
    const helper = run('/bin/sh', ['-c', 'command -v openclaw-gateway']);
    assert.equal(helper.status, 0);
    assert.ok(helper.stdout.trim());
    redactor = join(dirname(helper.stdout.trim()), 'lib', 'redact-stream.mjs');
  } catch {
    return { ...metadata(), sources, diagnostic: 'redactor-unavailable' };
  }
  function metadata() {
    return {
      phase: input.channelStatus ? 'channel-status' : 'install',
      exitCode: input.exitCode,
      startedAt: input.startedAt,
      capturedAt: now.toISOString(),
      elapsedToCaptureMs: now.getTime() - Date.parse(input.startedAt),
    };
  }
  function capture(name: string, read: () => ReturnType<Run>) {
    try {
      const result = read();
      const redacted = run(process.execPath, [redactor], result.stdout + '\n' + result.stderr);
      assert.equal(redacted.status, 0);
      sources[name] = {
        status: result.status === 0 ? 'observed' : 'unavailable',
        text: redacted.stdout.slice(-128 * 1024),
        truncated: redacted.stdout.length > 128 * 1024,
      };
    } catch {
      sources[name] = { status: 'unavailable' };
    }
  }
  capture(input.channelStatus ? 'channelStatus' : 'installStdout', () =>
    run('tail', ['-c', '131072', input.stdoutPath]),
  );
  capture(input.channelStatus ? 'channelStatusStderr' : 'installStderr', () =>
    run('tail', ['-c', '131072', input.stderrPath]),
  );
  capture('gatewayConsole', () => {
    const result = run('openclaw-gateway', ['log-path']);
    assert.equal(result.status, 0);
    return run('tail', ['-c', '262144', result.stdout.trim()]);
  });
  capture('gatewayStructured', () => run('tail', ['-c', '524288', input.nativeLogPath]));
  if (input.channelStatus) {
    const object = (value: unknown): Record<string, unknown> =>
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const channel = (value: unknown) => {
      const config = object(value);
      return {
        enabled: typeof config.enabled === 'boolean' ? config.enabled : null,
        accounts: Object.entries(object(config.accounts)).map(([id, account]) => ({
          id,
          enabled: typeof object(account).enabled === 'boolean' ? object(account).enabled : null,
        })),
      };
    };
    const project = (args: string[], select: (value: Record<string, unknown>) => unknown) => {
      const result = run('openclaw', args);
      assert.equal(result.status, 0);
      return {
        status: 0,
        stdout: JSON.stringify(select(object(JSON.parse(result.stdout)))),
        stderr: '',
      };
    };
    capture('savedChannelConfig', () =>
      project(['config', 'get', 'channels.agent-system-github', '--json'], channel),
    );
    // config.get may be cached; its snapshot is not the applied channel configuration.
    capture('gatewayConfigSnapshot', () =>
      project(
        ['gateway', 'call', 'config.get', '--params', '{}', '--timeout', '5000', '--json'],
        (snapshot) => ({
          valid: typeof snapshot.valid === 'boolean' ? snapshot.valid : null,
          configRevisionHash:
            typeof snapshot.configRevisionHash === 'string' ? snapshot.configRevisionHash : null,
          appliedConfigHash:
            typeof snapshot.appliedConfigHash === 'string' ? snapshot.appliedConfigHash : null,
          channel: channel(object(object(snapshot.config).channels)['agent-system-github']),
          reloadMode:
            typeof object(object(object(snapshot.config).gateway).reload).mode === 'string'
              ? object(object(object(snapshot.config).gateway).reload).mode
              : null,
        }),
      ),
    );
  }
  capture('openclawVersion', () => run('openclaw', ['--version']));
  capture('sourceRevision', () => run('git', ['-C', input.sourceDir, 'rev-parse', 'HEAD']));
  return { ...metadata(), sources };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions only.');
  const [label, exit, startedAt, stdoutPath, stderrPath, nativeLogPath, phase] =
    process.argv.slice(2);
  assert.ok(phase === undefined || phase === 'channel-status');
  assert.ok(label && /^[a-z0-9-]+$/u.test(label));
  assert.ok(exit && /^\d+$/u.test(exit) && Number(exit) <= 255);
  assert.ok(
    startedAt &&
      Number.isFinite(Date.parse(startedAt)) &&
      stdoutPath &&
      stderrPath &&
      nativeLogPath,
  );
  assert.ok(process.env.TMPDIR);
  assert.ok(process.env.GITHUB_WORKSPACE);
  const directory = join(process.env.TMPDIR, 'install-evidence', label);
  mkdirSync(dirname(directory), { recursive: true });
  // never replace an earlier attempt, even if a caller invokes capture twice.
  mkdirSync(directory);
  const evidence = installEvidence({
    exitCode: Number(exit),
    startedAt,
    stdoutPath,
    stderrPath,
    nativeLogPath,
    sourceDir: process.env.GITHUB_WORKSPACE,
    channelStatus: phase === 'channel-status',
  });
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
