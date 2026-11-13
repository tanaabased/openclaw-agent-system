import assert from 'node:assert/strict';

import automationReportName from '../agent/automations/automation-report-name.ts';

describe('agent/automations/automation-report-name', () => {
  it('should normalize only the scheduler label and preserve its distinguishing punctuation', () => {
    assert.equal(
      automationReportName('🛠️ Emori: backup-drive-nightly', 'backup'),
      'EMORI: BACKUP-DRIVE-NIGHTLY',
    );
    assert.equal(automationReportName('👩🏽‍💻 Review 🇺🇸', 'review'), 'REVIEW');
  });

  it('should use the declaration identity when no usable scheduler name is available', () => {
    for (const name of [undefined, null, '', '   ', '🔥💀🔥'])
      assert.equal(automationReportName(name, 'backup-drive-nightly'), 'BACKUP DRIVE NIGHTLY');
  });
});
