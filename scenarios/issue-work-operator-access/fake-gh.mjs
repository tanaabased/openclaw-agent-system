#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// the account client intentionally strips CI flags; preparation marks the disposable state.
const statePath = new URL('../state.json', import.meta.url);
const state = JSON.parse(readFileSync(statePath, 'utf8'));
if (state.fixture !== 'operator-access-ci') throw new Error('Unprepared GitHub fixture');
// this provider never makes a network request or accepts non-synthetic token values.
for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
  if (process.env[name] && process.env[name] !== 'synthetic-ci-value-not-a-credential')
    throw new Error('GitHub fixture accepts only synthetic credentials');
}
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('gh version 2.0.0 (operator fixture)\n');
  process.exit(0);
}
if (argv[0] !== 'api') throw new Error('Unsupported fixture command');
const endpoint = argv
  .find((value) => /^(\/?users?($|\/)|\/repos\/|\/search\/)/u.test(value))
  ?.replace(/^\//u, '');
const method = argv.includes('--method') ? argv[argv.indexOf('--method') + 1] : 'GET';
const user = (login) => ({ login, node_id: `U_${login}`, type: 'User' });
const data = user('fixture-data');
const repository = {
  id: 42,
  node_id: 'R_fixture',
  name: 'operator-fixture',
  owner: { login: 'tanaabased', node_id: 'O_fixture', type: 'Organization' },
  clone_url: 'https://github.com/tanaabased/operator-fixture.git',
  default_branch: 'main',
  archived: false,
  disabled: false,
};
const itemMatch = endpoint?.match(/^repos\/tanaabased\/operator-fixture\/issues\/(\d+)(.*)$/u);
const item = itemMatch
  ? state.items.find((entry) => entry.number === Number(itemMatch[1]))
  : undefined;
let response;
if (endpoint === 'user') response = data;
else if (endpoint === 'users/flagged' || endpoint === 'users/unflagged')
  response = user(endpoint.slice(6));
else if (endpoint === 'search/issues')
  response = { total_count: state.items.length, incomplete_results: false, items: state.items };
else if (endpoint === 'repos/tanaabased/operator-fixture') response = repository;
else if (endpoint === 'repos/tanaabased/operator-fixture/collaborators/fixture-data/permission')
  response = { permission: 'write' };
else if (item && itemMatch[2] === '') response = { ...item, comments: item.comments.length };
else if (item && itemMatch[2] === '/events')
  response = [
    {
      id: item.id + 1000,
      node_id: `AE_${item.number}`,
      event: 'assigned',
      created_at: item.updated_at,
      actor: user(item.actor),
      assigner: user(item.actor),
      assignee: data,
    },
  ];
else if (item && itemMatch[2] === '/comments') {
  if (method === 'POST') {
    const request = JSON.parse(readFileSync(0, 'utf8'));
    const comment = {
      id: item.id * 100 + item.comments.length + 1,
      node_id: `IC_${item.number}_${item.comments.length}`,
      body: request.body,
      user: data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      issue_url: `https://api.github.com/repos/tanaabased/operator-fixture/issues/${item.number}`,
    };
    item.comments.push(comment);
    writeFileSync(statePath, JSON.stringify(state));
    response = comment;
  } else response = item.comments;
} else throw new Error(`Unsupported fixture endpoint: ${method} ${endpoint}`);
if (argv.includes('--include'))
  process.stdout.write('HTTP/2 200 OK\r\nx-ratelimit-remaining: 9999\r\n\r\n');
const query = argv.includes('--jq') ? argv[argv.indexOf('--jq') + 1] : '.';
const result = spawnSync('jq', ['-cr', query], {
  input: JSON.stringify(response),
  encoding: 'utf8',
});
if (result.status !== 0) throw new Error('Fixture projection failed');
process.stdout.write(result.stdout);
