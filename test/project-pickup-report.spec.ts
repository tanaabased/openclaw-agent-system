import assert from 'node:assert/strict';
import report from '../agent/project-pickup-report.ts';
import ProjectPickupFailure from '../agent/project-pickup-failure.ts';
import fixture from './project-pickup-selection-fixture.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

const allowances = [{ repository: 'owner/repo', milestone: 10, used: 0, limit: 1 }];

describe('agent/project-pickup-report', () => {
  it('should preserve safe diagnostics and recovery without loading private state', () => {
    const diagnostic = providerDiagnostic('github', 'client-create', 'permission', {
      httpStatus: 403,
      providerMessage: 'denied with ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    });
    const original = Object.assign(new Error('github-account-permission-denied'), {
      providerDiagnostic: diagnostic,
    });
    const error = new ProjectPickupFailure(original);
    assert.equal(error.cause, original);
    assert.equal(error.code, original.message);
    assert.equal(error.failure.status, 'error');
    assert.match(error.failure.response, /❌.*Project pickup/);
    assert.match(error.failure.response, /github-account-permission-denied/);
    assert.match(error.failure.response, /denied with/);
    assert.match(error.failure.response, /permissions/);
    assert.match(error.failure.response, /Reconcile/);
    assert.doesNotMatch(error.failure.response, /ghp_|Debug|no eligible|Selected/);
  });

  for (const source of ['built-in', 'inline', 'file'] as const) {
    it(`should render literal ${source} guidance only in debug output`, () => {
      const outcome = {
        status: 'empty',
        allowances,
        selectionGuidance: {
          source,
          content: 'prefer [ready](bad)\n```\n> literal',
          path: source === 'file' ? '/workspace/selection.md' : undefined,
        },
      };
      const result = report({ outcome, debug: true });
      assert.match(result.response, new RegExp('Guidance source.*' + source));
      assert.match(
        result.response,
        /> ````text\n> prefer \[ready\]\(bad\)\n> ```\n> > literal\n> ````/,
      );
      assert.equal(
        report({ outcome }).response,
        report({ outcome: { status: 'empty', allowances } }).response,
      );
    });
  }

  it('should report the current comparison and verified assignment without issue lifecycle history', async () => {
    const f = fixture();
    const selection = await f.select();
    const outcome = await f.run({ selection: { ...selection, shortlist: [f.item.nodeId] } });
    const card = report({ outcome });
    assert.equal(card.notify, true);
    assert.match(card.response, /> ## 📥/);
    assert.match(card.response, /1 of 1 assigned/);
    assert.match(card.response, /Shortlist/);
    assert.match(card.response, /highest explicit priority/);
    assert.match(card.response, /0 eligible at the time/);
    assert.doesNotMatch(card.response, /PR delivery|Work chat|fingerprint/);
  });

  for (const status of ['empty', 'allowance-reached', 'at-capacity', 'paused', 'idle']) {
    it(`should show a ${status} outcome`, () => {
      const input = { outcome: { status, allowances }, capacity: { occupied: 1, limit: 1 } };
      const result = report(input);
      assert.equal(result.notify, true);
      assert.match(result.response, /> ## 📥/);
    });
  }

  for (const scope of ['preferred', 'fallback'] as const) {
    it(`should name the selected repository and ${scope} milestone choice`, () => {
      const result = report({
        outcome: {
          status: 'assigned',
          repository: 'owner/repo',
          issue: 3,
          allowances: [{ repository: 'owner/repo', milestone: [10, 11], limit: 1 }],
          summary: { eligible: 2, shortlist: [], skipped: 0, remaining: 1, pickupScope: scope },
        },
      });
      assert.match(result.response, /owner\/repo\/issues\/3/);
      assert.match(
        result.response,
        scope === 'preferred' ? /Preferred milestone/ : /Fallback within the selected repository/,
      );
      assert.match(result.response, /milestones 10, 11/);
      assert.doesNotMatch(result.response, /milestone\/10,11/);
    });
  }

  it('should link repo-wide allowances to issues', () => {
    assert.match(
      report({ outcome: { status: 'empty', allowances: [{ repository: 'owner/repo', limit: 1 }] } })
        .response,
      /owner\/repo\/issues/,
    );
  });

  it('should keep intermediate material private', () => {
    for (const status of ['discovering', 'selection-required', 'material'])
      assert.deepEqual(report({ outcome: { status } }), {
        response: '',
        notify: false,
      });
  });

  it('should distinguish an uncertain write from a definite github rejection', () => {
    const uncertain = report({
      outcome: { status: 'attempted', code: 'project-pickup-assignment-uncertain' },
    });
    assert.match(uncertain.response, /> ## ⚠️/);
    assert.match(uncertain.response, /do not repeat/);
    const rejected = report({
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
    const result = report({ outcome, debug: true });
    assert.match(result.response, /\\\[link\\\]/);
    assert.match(result.response, /Debug/);
    assert.doesNotMatch(report({ outcome }).response, /Debug/);
  });
});
