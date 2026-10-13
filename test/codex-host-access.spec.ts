import assert from 'node:assert/strict';

import codexHostAccess from '../agent/codex-host-access.ts';
import codexIssueNotice from '../agent/codex-issue-notice.ts';

describe('agent/codex-host-access', () => {
  it('should identify typed host access failures without mistaking provider or approval denials', () => {
    for (const code of ['EPERM', 'EACCES', 'automation-thread-host-access-required'])
      assert.equal(codexHostAccess(Object.assign(new Error('denied'), { code })), true);
    for (const error of [
      null,
      'EPERM',
      new Error('EACCES'),
      { code: '403' },
      { code: 'approval-denied' },
      { message: 'automatic approval review rejected the action' },
    ])
      assert.equal(codexHostAccess(error), false);
    const notice = codexIssueNotice({
      event: 'failure',
      code: 'codex-host-access-required',
      changed: true,
    });
    assert.equal(notice.notify, true);
    assert.match(notice.message, /native host approval/);
    assert.match(notice.message, /sandbox/);
    assert.match(notice.message, /denied/);
  });
});
