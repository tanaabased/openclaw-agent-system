import assert from 'node:assert/strict';

import cleanupGhaFixtures, {
  GhaFixtureProviderError,
  fixturePrefix,
  ghaFixtureCleanupOptions,
  ghaFixtureApi,
  type GhaFixtureApi,
} from '../scripts/gha-fixture-cleanup.ts';

import fixture from './gha-fixture-cleanup-fixture.ts';

describe('gha fixture cleanup', () => {
  it('resumes after a lost close response without repeating the close', async () => {
    const state = fixture();
    let lost = false;
    const api: GhaFixtureApi = async (...args) => {
      const value = await state.api(...args);
      if (!lost && args[0] === 'PATCH' && args[1].endsWith('/pulls/6')) {
        lost = true;
        throw new Error('response lost');
      }
      return value;
    };
    assert.equal((await cleanupGhaFixtures({ ...state.input, api })).ok, false);
    state.calls.length = 0;
    assert.equal((await cleanupGhaFixtures({ ...state.input, api })).ok, true);
    assert.equal(
      state.calls.some((call) => call.includes('PATCH ')),
      false,
    );
    assert.ok(state.calls.some((call) => call.endsWith('/fixture-branch')));
  });
  it('matches the exact repo, run and attempt boundary and leaves other resources alone', async () => {
    const state = fixture();
    assert.equal((await cleanupGhaFixtures(state.input)).ok, true);
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
    await cleanupGhaFixtures(state.input);
    state.calls.length = 0;
    assert.equal((await cleanupGhaFixtures(state.input)).ok, true);
    assert.equal(
      state.calls.some((call) => call.includes('PATCH ')),
      false,
    );
    assert.deepEqual(
      state.keys.map(({ id }) => id),
      [2],
    );
  });

  it('rejects active, foreign and mismatched attempts before inspecting fixtures', async () => {
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
      await assert.rejects(cleanupGhaFixtures(state.input));
      assert.equal(state.calls.length, 1);
    }
    assert.throws(() => fixturePrefix(77, 0, 2));
  });

  it('continues other categories after a provider failure and retries the remaining resource', async () => {
    const state = fixture();
    let failed = false;
    const api: GhaFixtureApi = async (...args) => {
      if (args[0] === 'DELETE' && args[1] === 'user/keys/1' && !failed) {
        failed = true;
        throw new GhaFixtureProviderError(503);
      }
      return state.api(...args);
    };
    const first = await cleanupGhaFixtures({ ...state.input, api });
    assert.equal(first.ok, false);
    assert.ok(first.outcomes.some(({ result }) => result === 'github-http-503'));
    assert.equal(state.signing.length, 0);
    assert.equal(state.issues[0]!.state, 'closed');
    assert.equal((await cleanupGhaFixtures({ ...state.input, api })).ok, true);
    assert.deepEqual(
      state.keys.map(({ id }) => id),
      [2],
    );
  });

  it('does not remove keys through a credential for the wrong account', async () => {
    const state = fixture();
    await assert.rejects(
      cleanupGhaFixtures({
        ...state.input,
        api: async (...args) => (args[1] === 'user' ? { login: 'pirog' } : state.api(...args)),
      }),
      /cleanup-account-mismatch/u,
    );
    assert.equal(
      state.calls.some((call) => call.startsWith('DELETE') || call.startsWith('PATCH')),
      false,
    );
    assert.equal(state.issues[0]!.state, 'open');
  });

  it('ignores prs that do not close a tagged fixture issue', async () => {
    const state = fixture();
    await cleanupGhaFixtures({
      ...state.input,
      api: async (...args) =>
        args[1] === 'graphql'
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
    assert.equal((await cleanupGhaFixtures(state.input)).ok, false);
    assert.equal(
      state.calls.some((call) => call.includes('/git/refs/heads/')),
      false,
    );
  });
});

describe('gha fixture cleanup options', () => {
  it('uses explicit token and selector options before environment defaults', () => {
    const options = ghaFixtureCleanupOptions(
      ['--token', 'explicit', '--run-id', '100', '--attempt', '2', '--no-dry-run', '--no-json'],
      {
        GH_TOKEN: 'first',
        GITHUB_TOKEN: 'second',
        GHA_FIXTURE_CLEANUP_RUN_ID: '99',
        GHA_FIXTURE_CLEANUP_ATTEMPT: '1',
        GHA_FIXTURE_CLEANUP_DRY_RUN: 'true',
        GHA_FIXTURE_CLEANUP_JSON: '1',
      },
    );
    assert.deepEqual(
      {
        token: options.token,
        run: options.runId,
        attempt: options.attempt,
        dryRun: options.dryRun,
        json: options.json,
      },
      { token: 'explicit', run: 100, attempt: 2, dryRun: false, json: false },
    );
    assert.equal(
      ghaFixtureCleanupOptions([], { GH_TOKEN: 'first', GITHUB_TOKEN: 'second' }).token,
      'first',
    );
    assert.equal(ghaFixtureCleanupOptions([], { GITHUB_TOKEN: 'second' }).token, 'second');
    assert.equal(
      ghaFixtureCleanupOptions([], { GH_TOKEN: '', GITHUB_TOKEN: 'second' }).token,
      'second',
    );
    assert.equal(ghaFixtureCleanupOptions(['--token', ''], { GH_TOKEN: 'first' }).token, '');
  });

  it('previews all fixture categories without making a provider write', async () => {
    const state = fixture();
    const report = await cleanupGhaFixtures({ ...state.input, dryRun: true });
    assert.equal(report.ok, true);
    assert.equal(report.dryRun, true);
    assert.ok(report.outcomes.some(({ result }) => result === 'would-remove'));
    assert.ok(report.outcomes.some(({ result }) => result === 'would-close'));
    assert.equal(
      state.calls.some((call) => /^(PATCH|DELETE)/u.test(call)),
      false,
    );
    assert.equal(state.keys.length, 2);
    assert.equal(state.issues[0]!.state, 'open');
    assert.equal(state.pull.state, 'open');
  });

  it('uses the same selected credential for metadata, keys and repository requests', async () => {
    const calls: Array<{ url: string; authorization: string }> = [];
    const api = ghaFixtureApi('selected-token', async (url, options) => {
      calls.push({ url, authorization: new Headers(options.headers).get('authorization') ?? '' });
      return options.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : new Response('{}', { status: 200 });
    });
    await api('GET', 'repos/tanaabased/openclaw-agent-system/actions/runs/100');
    await api('DELETE', 'user/keys/1');
    await api('PATCH', 'repos/tanaabased/big-test-bucket/issues/4', { state: 'closed' });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(({ authorization }) => authorization === 'Bearer selected-token'));
  });
});
