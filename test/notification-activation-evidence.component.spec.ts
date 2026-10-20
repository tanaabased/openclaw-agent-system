import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Execute only the activation shell with injected commands, never the installed scenario.
const commands = `
openclaw() {
  printf '%s\\n' "$*" >> "$TMPDIR/commands"
  case "$*" in
    'agent-system install --yes --json'|'agent-system install --json')
      printf '%s\\n' '{"status":"fixture-install-result"}'
      return "$INSTALL_STATUS" ;;
    'config get gateway --json')
      printf '%s\\n' '{}'
      return "$DIAGNOSTIC_STATUS" ;;
    'agent-system automations list --json')
      printf '%s\\n' '{}'
      return "$AUTOMATION_STATUS" ;;
    *) printf '%s\\n' '{}' ;;
  esac
}
openclaw-gateway() { printf '%s\\n' "$TMPDIR/gateway.log"; }
node() {
  case "$*" in
    *registration-evidence.ts*) printf '%s\\n' 'fixture-registration-evidence' ;;
    *) cat ;;
  esac
  return "$DIAGNOSTIC_STATUS"
}
jq() { cat; }
`;

for (const scenario of ['openclaw-issue', 'openclaw-pr', 'openclaw-intake', 'openclaw-lifecycle']) {
  for (const agent of ['emori', 'tanaabot']) {
    describe(`examples/${scenario} ${agent} install evidence`, () => {
      for (const [install, automation, diagnostic, expected] of [
        [0, 0, 0, 0],
        [0, 0, 64, 0],
        [37, 0, 0, 37],
        [37, 0, 64, 37],
        [0, 23, 0, 23],
      ]) {
        if (agent === 'emori' && automation) continue;
        it(`should preserve exit ${expected} for install ${install} automation ${automation} and diagnostic ${diagnostic}`, async () => {
          const source = await readFile(`examples/${scenario}/README.md`, 'utf8');
          const activation = source.match(
            agent === 'emori'
              ? /# should install emori in its fixture workspace\n([\s\S]*?)\n\n/u
              : /# should install tanaabot and activate native intake with explicit dispatch enrollment\n([\s\S]*?)\n```/u,
          )?.[1];
          assert.ok(activation);
          const root = await mkdtemp(join(tmpdir(), 'notification-activation-'));
          try {
            for (const agent of ['emori', 'tanaabot'])
              await mkdir(join(root, 'examples', scenario, agent), { recursive: true });
            await writeFile(join(root, 'gateway.log'), 'fixture-gateway-log\n');
            const result = spawnSync('bash', ['-e', '-c', commands + activation], {
              env: {
                ...process.env,
                GITHUB_WORKSPACE: root,
                TMPDIR: root,
                INSTALL_STATUS: String(install),
                AUTOMATION_STATUS: String(automation),
                DIAGNOSTIC_STATUS: String(diagnostic),
              },
              encoding: 'utf8',
              timeout: 5000,
            });
            assert.equal(result.status, expected, result.stderr);
            assert.equal(result.stdout.includes('fixture-registration-evidence'), expected !== 0);
            const calls = (await readFile(join(root, 'commands'), 'utf8')).trim().split('\n');
            assert.equal(
              calls.filter((call) => call.startsWith('agent-system install ')).length,
              1,
            );
            assert.ok(!calls.some((call) => /sync|restart/u.test(call)));
            const ready = await stat(join(root, 'notification-activation-ready')).catch(() => null);
            assert.equal(Boolean(ready), agent === 'tanaabot' && expected === 0);
            if (expected !== 0) {
              assert.ok(result.stdout.includes('fixture-install-result'));
              if (agent === 'tanaabot') assert.ok(result.stdout.includes('fixture-gateway-log'));
              assert.ok(!calls.some((call) => call.includes('notifications wait')));
            }
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        });
      }
    });
  }
}
