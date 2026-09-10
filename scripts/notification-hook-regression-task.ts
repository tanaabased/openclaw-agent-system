import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Installed runtime regression: isolated GitHub Actions only, no provider credentials.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'this regression runs only in GitHub Actions');
const [fixturePath, evidencePath, expectation] = process.argv.slice(2);
assert.ok(fixturePath && evidencePath);
assert.ok(expectation === 'baseline' || expectation === 'fixed');
const workspace = resolve(fixturePath);
const evidence = resolve(evidencePath);
await mkdir(evidence, { recursive: true });

function command(argv: string[], allowFailure = false) {
  const result = spawnSync('openclaw', argv, { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.error, undefined);
  if (!allowFailure)
    assert.equal(result.status, 0, `OpenClaw ${argv.slice(0, 2).join(' ')} failed`);
  return result;
}

command([
  'agents',
  'add',
  'hook-doctor-data',
  '--workspace',
  workspace,
  '--non-interactive',
  '--json',
]);
for (const state of ['unset', 'denied', 'enabled'] as const) {
  const setting = 'plugins.entries.agent-system.hooks.allowConversationAccess';
  if (state === 'unset') command(['config', 'unset', setting]);
  else command(['config', 'set', setting, state === 'enabled' ? 'true' : 'false']);
  const before = command(['config', 'get', 'plugins.entries.agent-system', '--json']).stdout;
  const doctor = command(['agent-system', 'doctor', '--agent', 'hook-doctor-data', '--json'], true);
  const inspected = command(['plugins', 'inspect', 'agent-system', '--runtime', '--json']);
  const after = command(['config', 'get', 'plugins.entries.agent-system', '--json']).stdout;
  assert.deepEqual(JSON.parse(after), JSON.parse(before), 'doctor must not change hook consent');
  const findings = JSON.parse(doctor.stdout) as {
    findings: Array<{ code: string; status: string; message: string; remediation?: string }>;
  };
  const runtime = JSON.parse(inspected.stdout) as { typedHooks: Array<{ name: string }> };
  const registered = runtime.typedHooks.some(({ name }) => name === 'before_prompt_build');
  assert.equal(registered, state === 'enabled');
  const blocked = findings.findings.find(
    ({ code }) => code === 'github-notification-hook-access-required',
  );
  await writeFile(
    join(evidence, `${state}.json`),
    JSON.stringify(
      {
        expectation,
        state,
        doctorExit: doctor.status,
        findings: findings.findings,
        registered,
        // Preserve the baseline's failing acceptance assertion as machine-readable evidence.
        requiredDiagnosticPresent: blocked !== undefined,
      },
      null,
      2,
    ),
  );
  if (expectation === 'baseline') {
    assert.equal(
      blocked,
      undefined,
      'baseline should reproduce the missing prerequisite diagnostic',
    );
  } else if (state !== 'enabled') {
    assert.equal(doctor.status, 1);
    assert.equal(blocked?.status, 'blocked');
    assert.ok(blocked?.message.includes(setting));
    assert.match(blocked?.remediation ?? '', /openclaw agent-system install/u);
  } else {
    assert.ok(
      findings.findings.some(
        ({ code, status }) => code === 'github-notification-hook-ready' && status === 'healthy',
      ),
    );
  }
}
process.stdout.write(`notification hook regression: ${expectation} evidence captured\n`);
