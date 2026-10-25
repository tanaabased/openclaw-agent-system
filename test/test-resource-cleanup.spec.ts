import assert from 'node:assert/strict';

import cleanupTestResources, {
  TestResourceProviderError,
  testResourcePrefix,
  type TestResourceApi,
} from '../scripts/test-resource-cleanup.ts';

const project = 'tanaabased/openclaw-agent-system';
const bucket = 'tanaabased/big-test-bucket';
const prefix = testResourcePrefix(77, 100, 2);
function fixture() {
  const run = {
    id: 100,
    run_attempt: 2,
    status: 'completed',
    path: '.github/workflows/pr-examples-notifications.yml',
    repository: { id: 77, full_name: project },
    head_repository: { id: 77 },
    run_started_at: '2026-10-25T10:00:00Z',
  };
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
  const api: TestResourceApi = async (account, method, route) => {
    calls.push(`${account} ${method} ${route}`);
    if (route.includes('/actions/runs/')) return run;
    if (route === 'user') return { login: account };
    if (route === `repos/${bucket}`)
      return { id: 1329940218, full_name: bucket, default_branch: 'main' };
    if (route.startsWith('user/keys?')) return [...keys];
    if (route.startsWith('user/ssh_signing_keys?')) return [...signing];
    if (method === 'DELETE' && route.startsWith('user/')) {
      const id = Number(route.split('/').at(-1));
      const list = route.startsWith('user/keys/') ? keys : signing;
      const index = list.findIndex((key) => key.id === id);
      if (index < 0) throw new TestResourceProviderError(404);
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
    if (method === 'PATCH' && route.endsWith('/issues/4')) {
      issues[0]!.state = 'closed';
      return issues[0];
    }
    if (method === 'DELETE' && route.includes('/git/refs/heads/')) {
      if (!branch) throw new TestResourceProviderError(404);
      branch = false;
      return null;
    }
    assert.fail(`unexpected fixture request ${method} ${route}`);
  };
  const input = { repositoryId: 77, runId: 100, attempt: 2, api };
  return { run, keys, signing, issues, pull, calls, api, input };
}

describe('test resource cleanup', () => {
  it('resumes after a lost close response without repeating the close', async () => {
    const state = fixture();
    let lost = false;
    const api: TestResourceApi = async (...args) => {
      const value = await state.api(...args);
      if (!lost && args[1] === 'PATCH' && args[2].endsWith('/pulls/6')) {
        lost = true;
        throw new Error('response lost');
      }
      return value;
    };
    assert.equal((await cleanupTestResources({ ...state.input, api })).ok, false);
    state.calls.length = 0;
    assert.equal((await cleanupTestResources({ ...state.input, api })).ok, true);
    assert.equal(
      state.calls.some((call) => call.includes(' PATCH ')),
      false,
    );
    assert.ok(state.calls.some((call) => call.endsWith('/fixture-branch')));
  });
  it('matches the exact repo, run and attempt boundary and leaves other resources alone', async () => {
    const state = fixture();
    assert.equal((await cleanupTestResources(state.input)).ok, true);
    assert.deepEqual(
      state.keys.map(({ id }) => id),
      [2],
    );
    assert.equal(state.signing.length, 0);
    assert.equal(state.issues[0]!.state, 'closed');
    assert.equal(state.issues[1]!.state, 'open');
    assert.equal(state.pull.state, 'closed');
    assert.ok(
      state.calls.some(
        (call) => call.includes('DELETE repos/') && call.endsWith('/fixture-branch'),
      ),
    );
  });

  it('safely runs cleanup again after resources are closed or already missing', async () => {
    const state = fixture();
    await cleanupTestResources(state.input);
    state.calls.length = 0;
    assert.equal((await cleanupTestResources(state.input)).ok, true);
    assert.equal(
      state.calls.some((call) => call.includes(' PATCH ')),
      false,
    );
    assert.deepEqual(
      state.keys.map(({ id }) => id),
      [2],
    );
  });

  it('rejects active, foreign and mismatched attempts before reading bot credentials', async () => {
    for (const mutate of [
      (run: ReturnType<typeof fixture>['run']) => {
        run.status = 'in_progress';
      },
      (run: ReturnType<typeof fixture>['run']) => {
        run.run_attempt = 3;
      },
      (run: ReturnType<typeof fixture>['run']) => {
        run.path = '.github/workflows/release.yml';
      },
      (run: ReturnType<typeof fixture>['run']) => {
        run.head_repository.id = 999;
      },
    ]) {
      const state = fixture();
      mutate(state.run);
      await assert.rejects(cleanupTestResources(state.input));
      assert.equal(state.calls.length, 1);
    }
    assert.throws(() => testResourcePrefix(77, 0, 2));
  });

  it('continues other categories after a provider failure and retries the remaining resource', async () => {
    const state = fixture();
    let failed = false;
    const api: TestResourceApi = async (...args) => {
      if (args[1] === 'DELETE' && args[2] === 'user/keys/1' && !failed) {
        failed = true;
        throw new TestResourceProviderError(503);
      }
      return state.api(...args);
    };
    const first = await cleanupTestResources({ ...state.input, api });
    assert.equal(first.ok, false);
    assert.ok(first.outcomes.some(({ result }) => result === 'github-http-503'));
    assert.equal(state.signing.length, 0);
    assert.equal(state.issues[0]!.state, 'closed');
    assert.equal((await cleanupTestResources({ ...state.input, api })).ok, true);
    assert.deepEqual(
      state.keys.map(({ id }) => id),
      [2],
    );
  });

  it('does not remove keys through a credential for the wrong account', async () => {
    const state = fixture();
    const result = await cleanupTestResources({
      ...state.input,
      api: async (...args) =>
        args[0] === 'tanaabot' && args[2] === 'user' ? { login: 'pirog' } : state.api(...args),
    });
    assert.equal(result.ok, false);
    assert.equal(
      state.calls.some((call) => call.startsWith('tanaabot DELETE')),
      false,
    );
    assert.equal(state.issues[0]!.state, 'closed');
  });

  it('ignores prs that do not close a tagged fixture issue', async () => {
    const state = fixture();
    await cleanupTestResources({
      ...state.input,
      api: async (...args) =>
        args[2] === 'graphql'
          ? {
              data: {
                node: {
                  closingIssuesReferences: {
                    nodes: [{ id: 'OTHER' }],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            }
          : state.api(...args),
    });
    assert.equal(state.pull.state, 'open');
    assert.equal(
      state.calls.some((call) => call.includes('/git/refs/heads/')),
      false,
    );
  });

  it('preserves protected branches even when the linked fixture pr is closed', async () => {
    const state = fixture();
    state.pull.head.ref = 'main';
    assert.equal((await cleanupTestResources(state.input)).ok, false);
    assert.equal(
      state.calls.some((call) => call.includes('/git/refs/heads/')),
      false,
    );
  });
});
