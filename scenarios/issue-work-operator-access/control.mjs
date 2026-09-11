import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.TMPDIR)
  throw new Error('CI-only operator acceptance fixture');
const root = resolve(process.env.TMPDIR, 'operator-access');
const workspace = join(root, 'agent');
const statePath = join(root, 'state.json');
const manifestPath = join(workspace, 'agent.yaml');
const action = process.argv[2];
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
}
function changeManifest(update) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  update(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
if (action === 'prepare') {
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const repository = join(root, 'repository');
  mkdirSync(repository);
  // only local disposable git data; the declared repository avoids clone and fetch.
  run('git', ['init', '-b', 'main', repository]);
  writeFileSync(join(repository, 'README.md'), '# Operator access fixture\n');
  run('git', ['add', 'README.md'], repository);
  run(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    ],
    repository,
  );
  run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], repository);
  copyFileSync(new URL('./fake-gh.mjs', import.meta.url), join(root, 'bin/fake-gh.mjs'));
  const fixturePath = join(root, 'bin/fake-gh.mjs').replaceAll("'", "'\\''");
  writeFileSync(join(root, 'bin/gh'), `#!/bin/sh\nexec node '${fixturePath}' "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(statePath, JSON.stringify({ items: [] }));
  writeFileSync(join(workspace, '.env'), 'GH_TOKEN_FIXTURE=synthetic-ci-value-not-a-credential\n', {
    mode: 0o600,
  });
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        'schema-version': 1,
        agent: { id: 'notification-data', name: 'Fixture Data', email: 'fixture@example.com' },
        environment: { dotenv: ['.env'], set: { GITHUB_ACTIONS: 'true' } },
        git: { worktrees: { repositories: { local: { 'github-42': repository } } } },
        github: {
          username: 'fixture-data',
          token: 'GH_TOKEN_FIXTURE',
          notifications: {
            'assignment-types': ['issue'],
            'interval-minutes': 1,
            'initial-mode': 'guided',
            'approved-actors': [
              { login: 'flagged', 'node-id': 'U_flagged', 'operator-owner': true },
              { login: 'unflagged', 'node-id': 'U_unflagged' },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
} else if (action === 'add') {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const kind = process.argv[3];
  assert.ok(['flagged', 'unflagged', 'denied', 'work'].includes(kind));
  const number = state.items.length + 1;
  state.items.push({
    id: 100 + number,
    node_id: `I_fixture_${number}`,
    number,
    title: `operator-access ${kind} control`,
    body: 'Exercise only session setup and its permission controls. Do not modify the fixture repository.',
    state: 'open',
    updated_at: new Date().toISOString(),
    repository_url: 'https://api.github.com/repos/tanaabased/operator-fixture',
    actor: kind === 'unflagged' ? 'unflagged' : 'flagged',
    labels: ['maintenance'],
    assignees: [{ login: 'fixture-data', node_id: 'U_fixture-data', type: 'User' }],
    comments: [],
  });
  writeFileSync(statePath, JSON.stringify(state));
} else if (action === 'work')
  changeManifest((manifest) => {
    manifest.github.notifications['initial-mode'] = 'work';
  });
else if (action === 'opt-out')
  changeManifest((manifest) => {
    manifest.github.notifications['approved-actors'][0]['operator-owner'] = false;
  });
else if (action === 'wait') {
  const number = Number(process.argv[3]);
  const configured = process.argv[4] === 'configured';
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    const report = JSON.parse(
      run('openclaw', [
        'gateway',
        'call',
        'sessions.list',
        '--params',
        '{"agentId":"notification-data"}',
        '--json',
      ]),
    );
    const session = report.sessions.find((entry) => entry.key.endsWith(`:${number}`));
    const evidence = await (await fetch('http://127.0.0.1:4010/proof/evidence')).json();
    assert.equal(evidence.strictMissCount, 0);
    if (
      evidence.finalResponseCount >= number &&
      session &&
      (configured
        ? session.owner?.actor?.type === 'agent' &&
          session.owner.actor.id === 'notification-data' &&
          session.color === 'purple' &&
          session.category === 'GitHub Issues'
        : session.owner?.actor?.id !== 'notification-data' && !session.color && !session.category)
    ) {
      ready = true;
      break;
    }
    await setTimeout(2000);
  }
  assert.ok(ready, 'persisted session state did not match the control');
} else if (action === 'evidence') {
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    const evidence = await (await fetch('http://127.0.0.1:4010/proof/evidence')).json();
    assert.equal(evidence.strictMissCount, 0);
    if (evidence.finalResponseCount === 5) {
      ready = true;
      break;
    }
    await setTimeout(2000);
  }
  assert.ok(ready, 'system-turn control did not complete');
} else throw new Error('Unsupported operator fixture action');
