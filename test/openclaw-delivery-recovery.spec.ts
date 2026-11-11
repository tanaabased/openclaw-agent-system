import assert from 'node:assert/strict';

import openClawDeliveryRecovery from '../agent/openclaw-delivery-recovery.ts';
import { attemptedAnnouncement } from './delivery-announcement-fixture.ts';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';

describe('agent/openclaw-delivery-recovery', () => {
  const input = { operation: 'announce', code: 'delivery-reconciliation-required', linked: true };

  it('should compose for missing optional completion records without claiming preview repairs them', () => {
    const next = openClawDeliveryRecovery(input);
    assert.match(next, /delivery compose/);
    assert.doesNotMatch(next, /prepare again|use delivery prepare/i);
    const unlinked = openClawDeliveryRecovery({ ...input, linked: false });
    assert.match(unlinked, /verify.*existing PR.*delivery link/i);
    assert.match(unlinked, /does not reconcile/i);
  });

  it('should reconcile an uncertain announcement at its original binding despite missing completion records', () => {
    const next = openClawDeliveryRecovery({
      ...input,
      announcement: attemptedAnnouncement('U_agent').state,
    });
    assert.match(next, /delivery announce.*original announcement attempt.*without reposting/i);
    assert.doesNotMatch(next, /delivery compose|use delivery prepare/i);
  });

  it('should distinguish state contention from missing drafts and preserve pending effects', () => {
    const conflict = { ...input, code: 'private-state-snapshot-conflict' };
    const unattempted = openClawDeliveryRecovery(conflict);
    assert.match(unattempted, /concurrent state.*current task context/i);
    assert.match(unattempted, /if no write was attempted/i);
    const attempted = openClawDeliveryRecovery({
      ...conflict,
      announcement: attemptedAnnouncement('U_agent').state,
    });
    assert.match(attempted, /delivery announce/);
    assert.doesNotMatch(attempted, /retry the same/i);
  });

  it('should direct a missing candidate to authored composition instead of access repair', () => {
    const next = openClawDeliveryRecovery({
      ...input,
      code: 'delivery-announcement-candidate-required',
    });
    assert.match(next, /delivery compose.*delivery candidate/i);
    assert.doesNotMatch(next, /restore.*access|prepare again/i);
  });

  for (const code of [
    'native-approval-denied',
    'delivery-account-changed',
    'dispatch-work-context-mismatch',
  ])
    it(`should stop rather than retry a write after ${code}`, () => {
      const next = openClawDeliveryRecovery({
        ...input,
        code,
        announcement: attemptedAnnouncement('U_agent').state,
      });
      assert.match(next, /stop.*denial.*identity\/authority/i);
      assert.doesNotMatch(next, /use delivery announce|retry the same|delivery compose/i);
    });

  it('should retain provider-specific access guidance instead of guessing from missing bookkeeping', () => {
    const next = openClawDeliveryRecovery({
      ...input,
      code: 'github-delivery-github-request',
      diagnostic: providerDiagnostic('github', 'api-request', 'permission', { httpStatus: 403 }),
    });
    assert.match(next, /permission|access|403/i);
    assert.match(next, /uncertain write/i);
    assert.doesNotMatch(next, /delivery compose|prepare again/i);
  });

  it('should inspect the original uncertain pr write instead of preparing another publication', () => {
    const next = openClawDeliveryRecovery({
      ...input,
      operation: 'publish',
      code: 'delivery-provider-failed',
      delivery: {
        id: 'a'.repeat(64),
        binding: {
          repositoryId: 'R_repo',
          issueId: 'I_issue',
          threadId: 'thread',
          worktree: '/work',
          branch: 'task',
          base: 'main',
          head: 'a'.repeat(40),
          authorId: 'U_agent',
        },
        creationAttempted: true,
        reconciled: false,
      },
      announcement: { attempted: true, receipt: { nodeId: 'IC_old', databaseId: 1 } },
    });
    assert.match(next, /delivery reconcile.*original PR publication attempt/i);
    assert.doesNotMatch(next, /use delivery prepare/i);
  });
});
