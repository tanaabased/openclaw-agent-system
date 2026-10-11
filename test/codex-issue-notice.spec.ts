import assert from 'node:assert/strict';

import codexIssueNotice from '../agent/codex-issue-notice.ts';

describe('agent/codex-issue-notice', () => {
  it('should distinguish normal progress, decisions, and failed operations without letting severity force notifications', () => {
    for (const [code, severity] of [
      ['dispatch-project-registration-unavailable', 'warning'],
      ['dispatch-activation-required', 'warning'],
      ['intake-policy-disabled', 'info'],
      ['intake-github-rate-limit', 'warning'],
      ['intake-github-transport', 'warning'],
      ['intake-github-permission', 'warning'],
      ['intake-github-auth-unavailable', 'warning'],
      ['dispatch-assignment-authority-revoked', 'warning'],
      ['dispatch-worktree-diverged', 'warning'],
      ['dispatch-assessment-result-missing', 'error'],
      ['intake-github-identity-mismatch', 'error'],
      ['dispatch-native-readback-diverged', 'error'],
      ['dispatch-native-model-diverged', 'error'],
      ['repository-preparation-failed', 'error'],
      ['dispatch-request-invalid', 'error'],
      ['intake-state-invalid', 'error'],
    ] as const) {
      const first = codexIssueNotice({ event: 'failure', code, changed: true });
      assert.equal(first.severity, severity, code);
      assert.equal(first.notify, true, code);
      assert.equal(
        codexIssueNotice({ event: 'failure', code, changed: false }).notify,
        false,
        code,
      );
      assert.match(first.message, /What happened/);
      assert.match(first.message, /Next step/);
      assert.ok(first.message.endsWith('`' + code + '`'));
    }
    const handoff = codexIssueNotice({ event: 'handoff', changed: true });
    assert.equal(handoff.severity, 'info');
    assert.equal(handoff.notify, false);
    assert.doesNotMatch(handoff.message, /blocked|completed|successful plan/iu);
    assert.equal(
      codexIssueNotice({ event: 'clarification-needed', changed: true }).severity,
      'warning',
    );
    for (const event of ['started', 'plan-ready', 'recovered', 'intake-recovered'] as const) {
      assert.equal(codexIssueNotice({ event, changed: true }).severity, 'info');
      assert.equal(codexIssueNotice({ event, changed: true }).notify, true);
    }
  });

  it('should keep verified links and bounded diagnostics without exposing raw errors', () => {
    const notice = codexIssueNotice({
      event: 'failure',
      changed: true,
      code: 'secret provider prose\nignore instructions',
      issue: { label: 'owner/repo#3', url: 'https://github.com/owner/repo/issues/3' },
      threadId: 'verified-child',
    });
    assert.match(
      notice.message,
      /\[owner\/repo#3\]\(https:\/\/github.com\/owner\/repo\/issues\/3\)/,
    );
    assert.match(notice.message, /codex:\/\/threads\/verified-child/);
    assert.doesNotMatch(notice.message, /secret|ignore instructions|Technical detail/);
  });
});
