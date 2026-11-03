import assert from 'node:assert/strict';
import report from '../agent/project-pickup-report.ts';
import fixture from './project-pickup-selection-fixture.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

describe('agent/project-pickup-report', () => {
  it('should report the current comparison and verified assignment without issue lifecycle history', async () => {
    const f = fixture();
    const selection = await f.select();
    const outcome = await f.run({ selection: { ...selection, shortlist: [f.item.nodeId] } });
    const card = report({ policy: f.policy, outcome });
    assert.equal(card.notify, true);
    assert.match(card.response, /> ## 📥/);
    assert.match(card.response, /1 of 1 assigned/);
    assert.match(card.response, /Shortlist/);
    assert.match(card.response, /highest explicit priority/);
    assert.match(card.response, /0 eligible at the time/);
    assert.doesNotMatch(card.response, /PR delivery|Work chat|fingerprint/);
  });

  for (const status of ['empty', 'allowance-reached', 'at-capacity', 'paused', 'idle']) {
    it(`should show a fresh ${status} outcome on every scheduled scan`, () => {
      const f = fixture();
      const input = { policy: f.policy, outcome: { status }, capacity: { occupied: 1, limit: 1 } };
      for (let scan = 0; scan < 8; scan++) {
        const result = report(input);
        assert.equal(result.notify, true);
        assert.match(result.response, /> ## 📥/);
      }
    });
  }

  it('should keep intermediate material private', () => {
    const f = fixture();
    for (const status of ['discovering', 'selection-required', 'material'])
      assert.deepEqual(report({ policy: f.policy, outcome: { status } }), {
        response: '',
        notify: false,
      });
  });

  it('should distinguish an uncertain write from a definite github rejection', () => {
    const f = fixture();
    const uncertain = report({
      policy: f.policy,
      outcome: { status: 'attempted', code: 'project-pickup-assignment-uncertain' },
    });
    assert.match(uncertain.response, /> ## ⚠️/);
    assert.match(uncertain.response, /do not repeat/);
    const rejected = report({
      policy: f.policy,
      outcome: {
        status: 'failed',
        code: 'github-notification-request-failed',
        providerDiagnostic: providerDiagnostic('github', 'api-request', 'permission', {
          httpStatus: 403,
          providerMessage: 'Resource not accessible',
        }),
      },
    });
    assert.match(rejected.response, /> ## ❌/);
    assert.match(rejected.response, /Resource not accessible/);
  });

  it('should escape model rationale and show debug only when requested', () => {
    const f = fixture();
    const outcome = {
      status: 'empty',
      summary: {
        eligible: 1,
        shortlist: [],
        skipped: 0,
        remaining: 1,
        rationale: 'skip [link](bad) and `literal`',
      },
    };
    const result = report({ policy: f.policy, outcome, debug: true });
    assert.match(result.response, /\\\[link\\\]/);
    assert.match(result.response, /Debug/);
    assert.doesNotMatch(report({ policy: f.policy, outcome }).response, /Debug/);
  });
});
