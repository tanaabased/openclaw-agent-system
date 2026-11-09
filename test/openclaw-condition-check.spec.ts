import assert from 'node:assert/strict';

import DiscoveryBudget from '../agent/discovery-budget.ts';
import openClawConditionCheck from '../agent/openclaw-condition-check.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

describe('agent/openclaw-condition-check', () => {
  it('should bound prerequisite reads and identify the unfinished operation without late continuation', async () => {
    let clock = 0;
    const caller = new AbortController();
    const budget = new DiscoveryBudget(20000, caller.signal, () => clock);
    const started = Promise.withResolvers<void>();
    const provider = Promise.withResolvers<string>();
    let continued = false;
    const check = openClawConditionCheck(
      async (budget) => {
        await budget.read('automation-readiness', () => {
          started.resolve();
          return provider.promise;
        });
        continued = true;
        return { status: 'ready', changed: false };
      },
      undefined,
      budget,
    );
    await started.promise;
    clock = 20000;
    caller.abort();
    const result = await check;
    assert.ok('outcome' in result && 'diagnostic' in result);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.more, true);
    assert.equal(result.changed, true);
    assert.deepEqual(result.diagnostic, {
      phase: 'automation-readiness',
      elapsedMs: 20000,
      reason: 'discovery-budget-exhausted',
    });
    provider.resolve('late readiness');
    await provider.promise;
    assert.equal(continued, false);
  });

  it('should retain sanitized provider causes rather than raw thrown text', async () => {
    const error = new GitHubWorkEventClientError(
      'github-api-failed',
      'private detail',
      {},
      undefined,
      providerDiagnostic('github', 'api-request', 'permission', { httpStatus: 403 }),
    );
    const result = await openClawConditionCheck(async (budget) =>
      budget.read('assignment-search', async () => {
        throw error;
      }),
    );
    assert.equal(result.code, 'github-api-failed');
    assert.equal(result.diagnostic?.phase, 'assignment-search');
    assert.equal(result.diagnostic?.providerDiagnostic?.httpStatus, 403);
    assert.equal(JSON.stringify(result).includes('private detail'), false);
  });

  it('should leave quiet and actionable results unchanged', async () => {
    for (const changed of [false, true]) {
      const value = { status: 'ready', changed };
      assert.equal(await openClawConditionCheck(async () => value), value);
    }
  });
});
