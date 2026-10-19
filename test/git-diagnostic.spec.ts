import assert from 'node:assert/strict';

import gitDiagnostic from '../tools/git/diagnostic.ts';
import codexIssueNotice from '../agent/codex-issue-notice.ts';
import githubDiagnostic from '../credentials/github-diagnostic.ts';

describe('tools/git/diagnostic', () => {
  it('should classify authentication and rejected writes while redacting credentials in cards', () => {
    const denied = gitDiagnostic(
      'remote: Permission to owner/repo denied. password=hidden ghp_abc123',
    );
    assert.equal(denied.provider, 'git');
    assert.equal(denied.classification, 'permission');
    const notice = codexIssueNotice({
      event: 'failure',
      changed: true,
      code: 'delivery-provider-failed',
      providerDiagnostic: denied,
    });
    assert.equal(notice.severity, 'error');
    assert.match(notice.message, /Git could not complete/);
    assert.match(notice.message, /Permission to owner\/repo denied/);
    assert.doesNotMatch(notice.message, /hidden|ghp_abc123/);
    assert.equal(gitDiagnostic('Permission denied (publickey).').classification, 'authentication');
  });
  it('should retain unknown rejection evidence without inventing a permission diagnosis', () => {
    const diagnostic = gitDiagnostic('remote rejected: custom quality hook failed');
    assert.equal(diagnostic.classification, 'unknown');
    assert.equal(
      gitDiagnostic('Could not resolve hostname github.com').classification,
      'transport',
    );
  });
  it('should show github status and safe upstream detail without treating throttling as denied permission', () => {
    const notice = codexIssueNotice({
      event: 'failure',
      changed: true,
      code: 'github-notification-request-failed',
      providerDiagnostic: githubDiagnostic({
        status: 403,
        remaining: 0,
        providerMessage: 'API rate limit exceeded. token=hidden',
      }),
    });
    assert.equal(notice.severity, 'warning');
    assert.match(notice.message, /HTTP status:\*\* 403/);
    assert.match(notice.message, /API rate limit exceeded/);
    assert.doesNotMatch(notice.message, /hidden/);
  });
});
