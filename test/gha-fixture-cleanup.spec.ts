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

  it('sweeps completed tagged attempts while preserving active, foreign and unverifiable resources', async () => {
    const state = fixture();
    for (const [id, attempt, status] of [
      [100, 1, 'completed'],
      [100, 20, 'in_progress'],
      [200, 1, 'completed'],
      [300, 1, 'queued'],
      [400, 1, 'completed'],
    ] as const)
      state.runs.set(`${id}/${attempt}`, {
        ...state.run,
        id,
        run_attempt: attempt,
        status,
        ...(id === 400 ? { head_repository: { id: 88 } } : {}),
      });
    state.keys.push(
      { id: 7, title: 'agent-system-test-77-200-1-work' },
      { id: 8, title: 'agent-system-test-77-300-1-work' },
      { id: 9, title: 'agent-system-test-77-400-1-work' },
      { id: 10, title: 'agent-system-test-77-500-1-work' },
      { id: 11, title: 'agent-system-test-88-200-1-work' },
      { id: 12, title: 'agent-system-test-malformed' },
    );
    const report = await cleanupGhaFixtures({ ...state.input, runId: '*', attempt: '*' });
    assert.equal(report.ok, false);
    assert.deepEqual(
      state.keys.map(({ id }) => id),
      [2, 8, 9, 10, 11, 12],
    );
    assert.ok(state.issues.every(({ state }) => state === 'closed'));
    assert.equal(state.pull.state, 'closed');
    assert.ok(
      report.outcomes.some(
        ({ target, result }) => target === '300/1' && result === 'preserved-active',
      ),
    );
    assert.ok(
      report.outcomes.some(
        ({ target, result }) => target === '500/1' && result === 'preserved-unverified',
      ),
    );
    assert.equal(state.calls.filter((call) => call.endsWith('/runs/100/attempts/2')).length, 1);
    assert.equal(
      state.calls.some((call) => call.includes('/runs/88/')),
      false,
    );
    state.calls.length = 0;
    await cleanupGhaFixtures({ ...state.input, runId: '*', attempt: '*' });
    assert.equal(
      state.calls.some((call) => call.startsWith('PATCH')),
      false,
    );
  });

  it('combines either wildcard with an exact selector and honors dry-run', async () => {
    for (const selectors of [
      { runId: 100, attempt: '*' },
      { runId: '*', attempt: 2 },
    ] as const) {
      const state = fixture();
      state.keys.splice(1);
      state.runs.set('100/1', { ...state.run, run_attempt: 1 });
      state.runs.set('200/2', { ...state.run, id: 200 });
      state.keys.push({ id: 7, title: 'agent-system-test-77-200-2-work' });
      const report = await cleanupGhaFixtures({ ...state.input, ...selectors, dryRun: true });
      assert.equal(report.ok, true);
      assert.equal(
        state.calls.some((call) => /^(PATCH|DELETE)/u.test(call)),
        false,
      );
      assert.equal(
        report.outcomes.some(({ target }) => target === '7'),
        selectors.runId === '*',
      );
      assert.equal(
        report.outcomes.some(({ resource, target }) => resource === 'issue' && target === '5'),
        selectors.attempt === '*',
      );
    }
    for (const value of ['10*', '**', '', '0', '-1']) {
      const state = fixture();
      const selectors = ghaFixtureCleanupOptions([`--run-id=${value}`, '--attempt', '*'], {});
      await assert.rejects(cleanupGhaFixtures({ ...state.input, ...selectors }));
      assert.equal(state.calls.length, 0);
    }
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
      ['--token', 'explicit', '--run-id', '100', '--attempt', '2'],
      {
        GH_TOKEN: 'first',
        GITHUB_TOKEN: 'second',
        GHA_FIXTURE_CLEANUP_RUN_ID: '99',
        GHA_FIXTURE_CLEANUP_ATTEMPT: '1',
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

  it('enables switches by flag or environment presence and rejects negative forms', () => {
    const unset = ghaFixtureCleanupOptions([], {});
    assert.equal(unset.dryRun, false);
    assert.equal(unset.json, false);
    for (const value of ['', '0', 'false', 'anything']) {
      const options = ghaFixtureCleanupOptions([], {
        GHA_FIXTURE_CLEANUP_DRY_RUN: value,
        GHA_FIXTURE_CLEANUP_JSON: value,
      });
      assert.equal(options.dryRun, true);
      assert.equal(options.json, true);
    }
    const flags = ghaFixtureCleanupOptions(
      ['--dry-run', '--json', '--run-id', '*', '--attempt', '*'],
      {},
    );
    assert.equal(flags.dryRun, true);
    assert.equal(flags.json, true);
    assert.equal(flags.runId, '*');
    assert.equal(flags.attempt, '*');
    for (const flag of ['--no-dry-run', '--no-json'])
      assert.throws(() => ghaFixtureCleanupOptions([flag], {}), /invalid-arguments/u);
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
