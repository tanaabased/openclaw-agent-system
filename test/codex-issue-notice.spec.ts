import assert from 'node:assert/strict';

import codexIssueNotice from '../agent/codex-issue-notice.ts';

describe('agent/codex-issue-notice', () => {
  it('should distinguish pending retirement observations from actionable cleanup blockers', () => {
    for (const code of [
      'retirement-native-archive-unverified',
      'retirement-native-reclamation-pending',
    ]) {
      const notice = codexIssueNotice({ event: 'failure', code, changed: false });
      assert.equal(notice.severity, 'info');
      assert.match(notice.next, /No action is needed/);
      assert.match(notice.next, /Intake will/);
    }
    for (const code of [
      'retirement-native-archive-denied',
      'retirement-worktree-dirty',
      'retirement-worktree-unpreserved',
      'retirement-native-resource-protected',
      'retirement-session-identity-unresolved',
    ]) {
      const notice = codexIssueNotice({ event: 'failure', code, changed: true });
      assert.equal(notice.severity, 'warning');
      assert.doesNotMatch(notice.next, /No action is needed/);
    }
  });

  it('should distinguish required automation updates from first-time setup while retaining warning severity', () => {
    const update = codexIssueNotice({
      event: 'failure',
      code: 'intake-automation-update-required',
      changed: true,
    });
    assert.equal(update.severity, 'warning');
    assert.ok(update.message.startsWith('> ## ✨ Automation update available'));
    assert.match(update.summary, /New intake is paused/);
    assert.match(update.summary, /Existing chats and work are retained/);
    assert.match(update.next, /Install.*update.*resume intake/);
    assert.match(update.message, /`intake-automation-update-required`/);
    const initial = codexIssueNotice({
      event: 'failure',
      code: 'intake-activation-required',
      changed: true,
    });
    assert.ok(initial.message.startsWith('> ## ⚠️ Set up intake automation'));
    assert.match(initial.summary, /not been activated/);
    assert.doesNotMatch(initial.message, /update available|needs an update/);
  });

  it('should customize informational icons while preserving warning and error icons', () => {
    assert.ok(
      codexIssueNotice({ event: 'intake-recovered', changed: true }).message.startsWith('> ## 💡 '),
    );
    assert.ok(
      codexIssueNotice({
        event: 'intake-recovered',
        changed: true,
        emoji: '✨',
      }).message.startsWith('> ## ✨ '),
    );
    for (const [code, emoji] of [
      ['intake-activation-required', '⚠️'],
      ['native-approval-denied', '❌'],
    ]) {
      assert.ok(
        codexIssueNotice({ event: 'failure', code, changed: true, emoji: '✨' }).message.startsWith(
          `> ## ${emoji} `,
        ),
      );
    }
  });

  it('should distinguish waiting for a scheduled trigger from an approval rejection', () => {
    const notice = codexIssueNotice({
      event: 'failure',
      code: 'dispatch-native-occurrence-unavailable',
      changed: true,
    });
    assert.equal(notice.severity, 'warning');
    assert.match(notice.next, /wait for the next scheduled intake/i);
    assert.match(notice.next, /during a scheduled run/);
    assert.match(notice.message, /dispatch-native-occurrence-unavailable/);
    assert.equal(
      codexIssueNotice({ event: 'failure', code: 'native-approval-denied', changed: true })
        .severity,
      'error',
    );
  });

  it('should describe lock contention as retryable without implying identity corruption', () => {
    const notice = codexIssueNotice({
      event: 'failure',
      code: 'private-state-file-lock-busy',
      changed: true,
    });
    assert.equal(notice.severity, 'warning');
    assert.match(notice.summary, /another operation|another update/i);
    assert.match(notice.next, /retry|scheduled check/i);
    assert.match(notice.next, /Do not delete the lock/);
    assert.doesNotMatch(notice.summary, /identity|did not match|corrupt/i);
    assert.equal(
      codexIssueNotice({ event: 'failure', code: 'intake-state-invalid', changed: true }).severity,
      'error',
    );
  });

  it('should recover stale previews through the same action without returning implementation to assessment', () => {
    const notice = codexIssueNotice({
      event: 'failure',
      code: 'dispatch-recovery-stale',
      changed: true,
    });
    assert.equal(notice.severity, 'warning');
    assert.match(notice.message, /same recovery action/);
    assert.match(notice.message, /action:handoff/);
    assert.match(notice.message, /do not refresh assessment context after implementation/);
    assert.match(notice.message, /existing authorization/);
  });

  it('should preserve the owning callers escaped recovery path without escaping it twice', () => {
    const notice = codexIssueNotice({
      event: 'failure',
      code: 'repository-preparation-changed',
      changed: true,
      actionMarkdown: 'Restore /work/my\\_repo before retrying.',
    });
    assert.ok(notice.message.includes('Restore /work/my\\_repo before retrying.'));
    assert.ok(!notice.message.includes('my\\\\'));
  });

  it('should distinguish normal progress, decisions, and failed operations without letting severity force notifications', () => {
    for (const [code, severity] of [
      ['delivery-attachment-pending', 'warning'],
      ['delivery-linkage-retried', 'info'],
      ['dispatch-project-git-auth-unavailable', 'error'],
      ['github-delivery-linkage-unverified', 'error'],
      ['delivery-reconciliation-required', 'error'],
      ['dispatch-project-registration-unavailable', 'warning'],
      ['dispatch-activation-required', 'warning'],
      ['intake-policy-disabled', 'info'],
      ['intake-github-rate-limit', 'warning'],
      ['intake-github-transport', 'warning'],
      ['intake-github-permission', 'warning'],
      ['intake-github-auth-unavailable', 'warning'],
      ['dispatch-assignment-authority-revoked', 'warning'],
      ['intake-github-identity-mismatch', 'error'],
      ['dispatch-native-readback-diverged', 'error'],
      ['dispatch-native-model-diverged', 'error'],
      ['repository-preparation-failed', 'error'],
      ['dispatch-request-invalid', 'error'],
      ['intake-state-invalid', 'error'],
    ] as const) {
      const first = codexIssueNotice({ event: 'failure', code, changed: true });
      assert.equal(first.severity, severity, code);
      assert.ok(first.message.startsWith('> ## '));
      assert.ok(first.message.split('\n').every((line) => line.startsWith('>')));
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
    for (const event of ['intake-recovered'] as const) {
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
    });
    assert.match(
      notice.message,
      /\[owner\/repo#3\]\(https:\/\/github.com\/owner\/repo\/issues\/3\)/,
    );
    assert.doesNotMatch(notice.message, /secret|ignore instructions|Technical detail/);
  });
});
