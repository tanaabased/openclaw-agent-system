import assert from 'node:assert/strict';
import {
  GhaFixtureProviderError,
  fixturePrefix,
  type GhaFixtureApi,
} from '../scripts/gha-fixture-cleanup.ts';

const project = 'tanaabased/openclaw-agent-system';
const bucket = 'tanaabased/big-test-bucket';
const prefix = fixturePrefix(77, 100, 2);
export default function fixture() {
  const run = {
    id: 100,
    run_attempt: 2,
    status: 'completed',
    path: '.github/workflows/pr-examples-notifications.yml',
    repository: { id: 77, full_name: project },
    head_repository: { id: 77 },
    run_started_at: '2026-10-25T10:00:00Z',
  };
  const runs = new Map([[`${run.id}/${run.run_attempt}`, run]]);
  const keys = [
    { id: 1, title: `${prefix}work` },
    { id: 2, title: 'agent-system-test-77-100-20-work' },
  ];
  const signing = [{ id: 3, title: `${prefix}signing` }];
  const issues = [
    {
      number: 4,
      node_id: 'ISSUE',
      title: `${prefix}issue`,
      state: 'open',
      user: { login: 'emoriwan' },
    },
    {
      number: 5,
      node_id: 'OTHER',
      title: 'agent-system-test-77-100-1-issue',
      state: 'open',
      user: { login: 'emoriwan' },
    },
  ];
  const pull = {
    number: 6,
    node_id: 'PR',
    state: 'open',
    user: { login: 'tanaabot' },
    created_at: '2026-10-25T10:01:00Z',
    head: { ref: 'fixture-branch', repo: { id: 1329940218 } },
  };
  let branch = true;
  const calls: string[] = [];
  const api: GhaFixtureApi = async (method, route) => {
    calls.push(`${method} ${route}`);
    if (route.startsWith(`repos/${project}/actions/runs/`)) {
      const parts = route.split('/');
      const source = runs.get(`${parts.at(-3)}/${parts.at(-1)}`);
      if (!source) throw new GhaFixtureProviderError(404);
      return source;
    }
    if (route === `repos/${project}`) return run.repository;
    if (route === 'user') return { login: 'tanaabot' };
    if (route === `repos/${bucket}`)
      return { id: 1329940218, full_name: bucket, default_branch: 'main' };
    if (route.startsWith('user/keys?')) return [...keys];
    if (route.startsWith('user/ssh_signing_keys?')) return [...signing];
    if (method === 'DELETE' && route.startsWith('user/')) {
      const id = Number(route.split('/').at(-1));
      const list = route.startsWith('user/keys/') ? keys : signing;
      const index = list.findIndex((key) => key.id === id);
      if (index < 0) throw new GhaFixtureProviderError(404);
      list.splice(index, 1);
      return null;
    }
    if (route.startsWith(`repos/${bucket}/issues?`)) return issues;
    if (route.startsWith(`repos/${bucket}/pulls?`)) return [pull];
    if (route === 'graphql')
      return {
        data: {
          node: {
            closingIssuesReferences: { nodes: [{ id: 'ISSUE' }], pageInfo: { hasNextPage: false } },
          },
        },
      };
    if (method === 'PATCH' && route.endsWith('/pulls/6')) {
      pull.state = 'closed';
      return pull;
    }
    if (method === 'PATCH' && route.includes('/issues/')) {
      const issue = issues.find(({ number }) => number === Number(route.split('/').at(-1)));
      assert.ok(issue);
      issue.state = 'closed';
      return issue;
    }
    if (method === 'DELETE' && route.includes('/git/refs/heads/')) {
      if (!branch) throw new GhaFixtureProviderError(404);
      branch = false;
      return null;
    }
    assert.fail(`unexpected fixture request ${method} ${route}`);
  };
  const input = { runId: 100, attempt: 2, api };
  return { run, runs, keys, signing, issues, pull, calls, api, input };
}
