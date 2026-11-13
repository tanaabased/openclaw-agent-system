import assert from 'node:assert/strict';
import report from '../agent/issue-pickup-report.ts';
import IssuePickupFailure from '../agent/issue-pickup-failure.ts';
import fixture from './issue-pickup-selection-fixture.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

const allowances = [{ repository: 'owner/repo', milestone: 10, used: 0, limit: 1 }];

describe('agent/issue-pickup-report', () => {
  it('should explain type-only empty scans and distinguish missing provider evidence', () => {
    const result = report({
      outcome: {
        status: 'empty',
        allowances: [{ ...allowances[0]!, filters: { types: ['Bug', 'Customer Request'] } }],
        summary: { eligible: 0, shortlist: [], skipped: 0, remaining: 0 },
      },
    });
    assert.match(result.response, /Issue type filters.*Bug.*Customer Request/);
    assert.match(result.response, /No eligible issues matched/);
    const failed = report({ outcome: { status: 'failed', code: 'issue-pickup-type-unavailable' } });
    assert.match(failed.response, /issue-pickup-type-unavailable/);
    assert.doesNotMatch(failed.response, /No eligible issues matched/);
  });

  it('should explain contradictory and no-match criteria without hiding unreadable issues', () => {
    for (const [required, excluded, contradictory] of [
      ['bug', 'BUG', true],
      ['bug', 'blocked', false],
      ['bug*', 'BUG*', true],
      ['bug*', 'bug', false],
      ['bug', 'b*', true],
    ] as const) {
      const result = report({
        outcome: {
          status: 'empty',
          allowances: [{ ...allowances[0]!, filters: { labels: [required, `!${excluded}`] } }],
          summary: { eligible: 0, shortlist: [], skipped: 1, remaining: 0 },
        },
      });
      assert.match(result.response, /require all.*bug/);
      assert.match(result.response, /exclude any/);
      assert.match(result.response, /No eligible issues matched/);
      assert.match(result.response, /1 issues could not be read/);
      assert.equal(result.response.includes('Contradictory'), contradictory);
      assert.doesNotMatch(result.response, /label does not exist/);
    }
  });

  it('should preserve safe diagnostics and recovery without loading private state', () => {
    const diagnostic = providerDiagnostic('github', 'client-create', 'permission', {
      httpStatus: 403,
      providerMessage: 'denied with ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    });
    const original = Object.assign(new Error('github-account-permission-denied'), {
      providerDiagnostic: diagnostic,
    });
    const error = new IssuePickupFailure(original);
    assert.equal(error.cause, original);
    assert.equal(error.code, original.message);
    assert.equal(error.failure.status, 'error');
    assert.match(error.failure.response, /❌.*Issue pickup/);
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

  it('should distinguish an unreadable repository from an empty one in one outcome card', () => {
    const diagnostic = providerDiagnostic('github', 'api-request', 'permission', {
      httpStatus: 403,
      providerMessage: 'Access denied to [private](repo)',
    });
    const result = report({
      outcome: {
        status: 'empty',
        allowances: [
          { repository: 'owner/empty', milestone: 10, used: 0, limit: 1, eligible: 0 },
          {
            repository: 'owner/unreadable',
            milestone: 10,
            used: 0,
            limit: 1,
            code: 'github-notification-request-failed',
            providerDiagnostic: diagnostic,
          },
        ],
      },
    });
    assert.match(result.response, /⚠️.*could not fully check/);
    assert.match(result.response, /owner\/empty.*0 eligible/);
    assert.match(
      result.response,
      /owner\/unreadable.*eligible count unavailable.*github-notification-request-failed/,
    );
    assert.match(result.response, /Access denied to \\\[private\\\]/);
    assert.equal(result.response.match(/> ##/g)?.length, 1);
  });

  it('should distinguish an uncertain write from a definite github rejection', () => {
    const uncertain = report({
      outcome: { status: 'attempted', code: 'issue-pickup-assignment-uncertain' },
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
