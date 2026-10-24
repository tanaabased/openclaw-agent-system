import assert from 'node:assert/strict';

import installEvidence from '../scripts/install-evidence.ts';

const input = {
  exitCode: 1,
  startedAt: '2026-10-24T08:10:00Z',
  stdoutPath: '/tmp/install.json',
  stderrPath: '/tmp/install.stderr',
  nativeLogPath: '/tmp/native.log',
  sourceDir: '/checkout',
};
const now = new Date('2026-10-24T08:10:01Z');
type Run = NonNullable<Parameters<typeof installEvidence>[1]>;
const success = (stdout: string) => ({ status: 0, stdout, stderr: '' });

describe('scripts/install-evidence', () => {
  it('should retain the failed attempt and redact every source without retrying a mutation', () => {
    const calls: string[] = [];
    const run: Run = (command, args, text) => {
      calls.push([command, ...args].join(' '));
      if (command === '/bin/sh') return success('/helpers/openclaw-gateway\n');
      if (command === 'openclaw-gateway') return success('/tmp/console.log\n');
      if (text !== undefined) return success(text.replaceAll('secret-value', '[REDACTED]'));
      return success('UNAVAILABLE secret-value');
    };
    const evidence = installEvidence(input, run, now);
    assert.equal(evidence.exitCode, 1);
    assert.equal(evidence.elapsedToCaptureMs, 1000);
    assert.equal(Object.keys(evidence.sources).length, 6);
    for (const source of Object.values(evidence.sources)) {
      assert.equal(source.status, 'observed');
      assert.match(source.text!, /UNAVAILABLE \[REDACTED\]/u);
    }
    assert.ok(!JSON.stringify(evidence).includes('secret-value'));
    assert.deepEqual(
      calls.filter((call) => call.startsWith('openclaw ')),
      ['openclaw --version'],
    );
    assert.ok(calls.includes('tail -c 524288 /tmp/native.log'));
    assert.ok(calls.includes('git -C /checkout rev-parse HEAD'));
  });

  it('should withhold raw diagnostics when redaction fails', () => {
    const run: Run = (command, _args, text) => {
      if (command === '/bin/sh') return success('/helpers/openclaw-gateway');
      if (text !== undefined) return { status: 1, stdout: 'secret-value', stderr: '' };
      return success('secret-value');
    };
    const evidence = installEvidence({ ...input, channelStatus: true }, run, now);
    assert.ok(!JSON.stringify(evidence).includes('secret-value'));
    assert.ok(Object.values(evidence.sources).every((source) => source.status === 'unavailable'));
    assert.equal(evidence.exitCode, 1);
  });

  it('should preserve the failed channel response separately from saved and gateway config evidence', () => {
    const calls: string[] = [];
    const saved = {
      accounts: {
        'retired-agent': { enabled: false },
        'intake-tanaabot': { enabled: true, token: 'unknown-secret' },
      },
    };
    const run: Run = (command, args, text) => {
      calls.push([command, ...args].join(' '));
      if (command === '/bin/sh') return success('/helpers/openclaw-gateway');
      if (command === 'openclaw-gateway') return success('/tmp/console.log');
      if (text !== undefined) {
        assert.ok(!text.includes('unknown-secret'));
        return success(text);
      }
      if (args[0] === 'config') return success(JSON.stringify(saved));
      if (args.includes('config.get'))
        return success(
          JSON.stringify({
            valid: true,
            configRevisionHash: 'saved-revision',
            appliedConfigHash: 'older-applied-revision',
            raw: 'unknown-secret',
            config: {
              channels: { 'agent-system-github': saved },
              gateway: { auth: { token: 'unknown-secret' }, reload: { mode: 'hybrid' } },
            },
          }),
        );
      if (args.includes(input.stdoutPath))
        return success(
          '{"channelAccounts":{"agent-system-github":[{"accountId":"retired-agent","enabled":false}]}}',
        );
      return success('native evidence');
    };
    const evidence = installEvidence({ ...input, exitCode: 7, channelStatus: true }, run, now);
    assert.equal(evidence.exitCode, 7);
    assert.equal(evidence.phase, 'channel-status');
    assert.deepEqual(
      JSON.parse(evidence.sources.channelStatus!.text!).channelAccounts['agent-system-github'],
      [{ accountId: 'retired-agent', enabled: false }],
    );
    assert.deepEqual(JSON.parse(evidence.sources.savedChannelConfig!.text!).accounts, [
      { id: 'retired-agent', enabled: false },
      { id: 'intake-tanaabot', enabled: true },
    ]);
    const snapshot = JSON.parse(evidence.sources.gatewayConfigSnapshot!.text!);
    assert.equal(snapshot.configRevisionHash, 'saved-revision');
    assert.equal(snapshot.appliedConfigHash, 'older-applied-revision');
    assert.equal(snapshot.reloadMode, 'hybrid');
    assert.ok(!JSON.stringify(evidence).includes('unknown-secret'));
    assert.deepEqual(
      calls.filter((call) => call.startsWith('openclaw ')),
      [
        'openclaw config get channels.agent-system-github --json',
        'openclaw gateway call config.get --params {} --timeout 5000 --json',
        'openclaw --version',
      ],
    );
  });

  it('should stop collection if the shared redactor cannot be located', () => {
    const calls: string[] = [];
    const evidence = installEvidence(
      input,
      (command) => {
        calls.push(command);
        throw new Error('secret-value');
      },
      now,
    );
    assert.deepEqual(calls, ['/bin/sh']);
    assert.deepEqual(evidence.sources, {});
    assert.ok('diagnostic' in evidence);
    assert.equal(evidence.diagnostic, 'redactor-unavailable');
    assert.ok(!JSON.stringify(evidence).includes('secret-value'));
  });

  it('should bound retained output and distinguish missing evidence from success', () => {
    const run: Run = (command, args, text) => {
      if (command === '/bin/sh') return success('/helpers/openclaw-gateway');
      if (command === 'openclaw-gateway') return success('/tmp/console.log');
      if (text !== undefined) return success(text);
      if (args.includes(input.stderrPath)) return { status: 1, stdout: '', stderr: 'file missing' };
      return success('x'.repeat(200_000));
    };
    const evidence = installEvidence(input, run, now);
    assert.equal(evidence.sources.installStderr!.status, 'unavailable');
    assert.equal(evidence.sources.gatewayStructured!.text!.length, 128 * 1024);
    assert.equal(evidence.sources.gatewayStructured!.truncated, true);
  });
});
