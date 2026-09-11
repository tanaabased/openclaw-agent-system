import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

import observeControl from './observation.mjs';
import { updateFixtureState } from './state.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.TMPDIR)
  throw new Error('CI-only operator acceptance fixture');
const root = resolve(process.env.TMPDIR, 'operator-access');
const workspace = join(root, 'agent');
const statePath = join(root, 'state.json');
const manifestPath = join(workspace, 'agent.yaml');
const action = process.argv[2];
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0)
    throw new Error(
      `${command} failed: status=${result.status} signal=${result.signal} ${result.error?.message ?? ''} ${(result.stderr ?? '').slice(0, 2000)}`,
    );
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
  const fixturePath = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url)).replaceAll(
    "'",
    "'\\''",
  );
  const quotedStatePath = statePath.replaceAll("'", "'\\''");
  writeFileSync(
    join(root, 'bin/gh'),
    `#!/bin/sh\nexec node '${fixturePath}' '${quotedStatePath}' "$@"\n`,
    {
      mode: 0o755,
    },
  );
  writeFileSync(statePath, JSON.stringify({ fixture: 'operator-access-ci', items: [] }));
  writeFileSync(join(workspace, '.env'), 'GH_TOKEN_FIXTURE=synthetic-ci-value-not-a-credential\n', {
    mode: 0o600,
  });
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        'schema-version': 1,
        agent: { id: 'notification-data', name: 'Fixture Data', email: 'fixture@example.com' },
        environment: { dotenv: ['.env'] },
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
  const kind = process.argv[3];
  assert.ok(['flagged', 'unflagged', 'denied', 'work'].includes(kind));
  await updateFixtureState(statePath, (state) => {
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
  });
} else if (action === 'work')
  changeManifest((manifest) => {
    manifest.github.notifications['initial-mode'] = 'work';
  });
else if (action === 'opt-out')
  changeManifest((manifest) => {
    manifest.github.notifications['approved-actors'][0]['operator-owner'] = false;
  });
else if (action === 'wait' || action === 'evidence') {
  const phase = action === 'evidence' ? 'implementation' : 'assignment';
  const number = action === 'evidence' ? 4 : Number(process.argv[3]);
  const configured = action === 'evidence' || process.argv[4] === 'configured';
  const conversationId = `github:issue:R_fixture:${number}`;
  const digest = createHash('sha256').update(conversationId).digest('hex');
  const conversationPath = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'tanaab/agent-system/notification-data/channels/github-notification-conversations',
    `${digest}.json`,
  );
  const deadline = Date.now() + 180_000;
  let observation;
  try {
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
      let conversation;
      try {
        conversation = JSON.parse(readFileSync(conversationPath, 'utf8')).conversation;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const response = await fetch('http://127.0.0.1:4010/proof/evidence', {
        signal: AbortSignal.timeout(5000),
      });
      assert.ok(response.ok, `model evidence returned HTTP ${response.status}`);
      const evidence = await response.json();
      observation = observeControl({
        number,
        configured,
        phase,
        sessions: report.sessions,
        conversation,
        evidence,
      });
      assert.equal(evidence.strictMissCount, 0, 'strict provider fixture did not match');
      if (observation.ready) break;
      await setTimeout(2000);
    }
    assert.ok(observation?.ready, `operator control ${number}/${phase} did not finish`);
    writeFileSync(join(root, `${phase}-${number}-verified`), JSON.stringify(observation));
    process.stdout.write(`${JSON.stringify(observation)}\n`);
  } catch (error) {
    process.stderr.write(
      `Operator control observation: ${JSON.stringify(observation ?? { number, phase })}\n`,
    );
    for (const name of ['gateway.log', 'openclaw-aimock.log']) {
      try {
        const lines = readFileSync(join(process.env.TMPDIR, name), 'utf8')
          .split('\n')
          .filter((line) =>
            /Unhandled request error|No fixture matched|github-notifications:.*(?:failed|session setup)/u.test(
              line,
            ),
          )
          .slice(-20)
          .map((line) => line.slice(0, 1000));
        process.stderr.write(`${name}:\n${lines.join('\n')}\n`);
      } catch {
        /* optional diagnostics */
      }
    }
    throw error;
  }
} else throw new Error('Unsupported operator fixture action');
