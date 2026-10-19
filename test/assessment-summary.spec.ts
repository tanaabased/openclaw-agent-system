import assert from 'node:assert/strict';
import assessmentSummary, {
  assessmentSummaryOwnPublications,
} from '../agent/assessment-summary.ts';
import recordDispatchResult from '../agent/dispatch-result.ts';
import { automationHash } from '../agent/automation-hash.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { AssessmentSummaryRequest } from '../agent/assessment-summary-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { intakeFixture } from './github-intake-fixture.ts';

function fixture() {
  const github = intakeFixture();
  const intake: IntakeRecord = {
    version: 1,
    status: 'admitted',
    scope: 'scope',
    agentId: 'receiver',
    workspaceDir: '/worktree',
    host: 'github.com',
    observedAt: 1,
    admittedAt: 1,
    requiresRevalidation: true,
    evidence: {
      policyDigest: 'policy',
      mode: 'plan',
      open: true,
      assigned: true,
      repositoryReadable: true,
      ownerPinned: true,
      actorPinned: true,
    },
    id: 'a'.repeat(64),
    repository: github.repository,
    issue: github.item,
    receiving: github.client.identity,
    assignment: { ...github.events[0]!, event: 'assigned' },
  };
  const record: SharedDispatchRecord = {
    id: 'b'.repeat(64),
    intakeId: intake.id,
    issueKey: 'c'.repeat(64),
    sourceThreadId: 'intake',
    phase: 'assessing',
    createdAt: 1,
    manifestDigest: 'manifest',
    threadId: 'issue',
    worktree: '/worktree',
    request: { prompt: 'assess' },
    context: '{}',
    routing: '{}',
  };
  const result = {
    version: 1,
    outcome: 'plan-ready',
    summary: 'Repair the journey.',
    assessment: 'An omitted return hides the result.',
    planSummary: 'Return the result.',
    plan: 'Repair handler.ts.',
    fullAssessment: 'The complete private plan, evidence and limitations.',
    evidence: [],
    progress: { completed: [], remaining: [] },
  };
  const retain = (value = result) =>
    recordDispatchResult({
      record,
      intake,
      threadId: 'issue',
      turnId: 'turn',
      worktree: '/worktree',
      policy: github.policy,
      result: value,
      previousResultDigest: record.result && automationHash(record.result),
    });
  const selection = {
    version: 1 as const,
    requestedSkill: 'agent-system-feedback-reply',
    defaultSkill: true,
    skill: {
      name: 'agent-system-feedback-reply',
      path: '/skill',
      scope: 'user',
      digest: 'd'.repeat(64),
    },
    observedAt: 1,
  };
  let writes = 0,
    saves = 0,
    lost = false,
    forbidden = false,
    changed = false;
  let receipt: { nodeId: string; databaseId: number; body: string } | undefined;
  const run = (
    action: AssessmentSummaryRequest,
    turnId = 'turn',
    authorityDigest = 'e'.repeat(64),
  ) =>
    assessmentSummary({
      record,
      intake,
      action,
      turnId,
      authorityDigest,
      presentation: result.fullAssessment,
      authorize: async () => {
        if (forbidden) throw new Error('native-approval-denied');
      },
      select: async () => ({
        ...selection,
        skill: { ...selection.skill, digest: (changed ? 'f' : 'd').repeat(64) },
      }),
      connect: async () => ({
        client: {
          findOwnIssueComment: async () => receipt,
          createIssueComment: async (_owner, _repo, number, body) => {
            assert.equal(number, 3);
            writes++;
            receipt = { nodeId: 'comment-' + writes, databaseId: writes, body };
            if (lost) throw new Error('response-lost');
            return receipt;
          },
        },
      }),
      redact: (text) => text,
      save: async () => {
        saves++;
      },
    });
  const compose = async () => {
    const composed = await run({ operation: 'compose' });
    assert.equal(composed.status, 'composition-ready');
    assert.ok('digest' in composed);
    assert.equal(
      (
        await run({
          operation: 'candidate',
          digest: composed.digest,
          publicText:
            'Today you finish the action without seeing a result. The plan would show it immediately, so you can keep going.',
        })
      ).status,
      'candidate-recorded',
    );
    const preview = await run({ operation: 'publish' });
    assert.equal(preview.status, 'publication-ready');
    assert.ok('digest' in preview);
    return preview.digest!;
  };
  return {
    record,
    result,
    retain,
    run,
    compose,
    get writes() {
      return writes;
    },
    get saves() {
      return saves;
    },
    lose: () => {
      lost = true;
    },
    revoke: () => {
      forbidden = true;
    },
    changeSkill: () => {
      changed = true;
    },
    own: () =>
      assessmentSummaryOwnPublications(
        record,
        intake,
        {
          client: {
            createIssueComment: async () => {
              throw new Error('unexpected write');
            },
            findOwnIssueComment: async () => receipt,
          },
        },
        (text) => text,
      ),
    clearProvider: () => {
      receipt = undefined;
    },
  };
}

describe('agent/assessment-summary', () => {
  it('requires a complete retained assessment before composition and keeps publication separate', async () => {
    const f = fixture();
    assert.equal((await f.run({ operation: 'compose' })).status, 'blocked');
    f.retain();
    const composed = await f.run({ operation: 'compose' });
    assert.equal(composed.status, 'composition-ready');
    assert.ok('source' in composed && composed.source?.kind === 'assessment');
    assert.ok(
      'privateResponse' in composed && composed.privateResponse === f.result.fullAssessment,
    );
    assert.equal(f.writes, 0);
    assert.equal((await f.run({ operation: 'publish', digest: 'a'.repeat(64) })).status, 'blocked');
    assert.deepEqual(f.record.result, f.result);
  });
  it('publishes once and reuses the provider receipt across repeated submission and retry', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    const published = await f.run({ operation: 'publish', digest });
    assert.equal(published.status, 'published');
    assert.ok(
      'presentation' in published && published.presentation?.includes(f.result.fullAssessment),
    );
    assert.equal(f.record.phase, 'complete');
    f.retain();
    assert.equal(f.record.assessmentRevision, 1);
    assert.equal((await f.run({ operation: 'publish', digest })).status, 'published');
    assert.equal(f.writes, 1);
  });
  it('reconciles a lost response without repeating the write or losing the private plan', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    f.lose();
    assert.equal((await f.run({ operation: 'publish', digest })).status, 'blocked');
    assert.deepEqual(f.record.result, f.result);
    assert.equal((await f.run({ operation: 'publish', digest })).status, 'reconcile-required');
    assert.equal((await f.run({ operation: 'reconcile' }, 'recovery-turn')).status, 'published');
    assert.equal(f.writes, 1);
  });
  it('recognizes an uncertain own summary from the provider without writing or blocking human feedback', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    f.lose();
    await f.run({ operation: 'publish', digest });
    assert.deepEqual(await f.own(), ['comment-1']);
    assert.equal(f.record.assessmentSummaries?.[0]?.receipt, undefined);
    f.clearProvider();
    assert.deepEqual(await f.own(), []);
    assert.equal(f.writes, 1);
  });
  it('does not recreate an uncertain or deleted provider comment', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    f.lose();
    await f.run({ operation: 'publish', digest });
    f.clearProvider();
    const unknown = await f.run({ operation: 'reconcile' });
    assert.equal(unknown.status, 'blocked');
    assert.ok('code' in unknown && unknown.code === 'assessment-summary-publication-unconfirmed');
    assert.equal(f.writes, 1);
  });
  it('rejects a stale candidate and changed composition skill before publication', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    f.changeSkill();
    const blocked = await f.run({ operation: 'publish', digest });
    assert.ok('code' in blocked && blocked.code === 'assessment-summary-composition-changed');
    const refreshed = await f.run({ operation: 'compose' });
    assert.equal(refreshed.status, 'composition-ready');
    assert.ok('digest' in refreshed && refreshed.digest !== digest);
    assert.equal(f.record.assessmentSummaries?.[0]?.publicText, undefined);
    assert.equal(
      (
        await f.run({
          operation: 'candidate',
          digest: refreshed.digest,
          publicText: 'Updated summary.',
        })
      ).status,
      'candidate-recorded',
    );

    assert.equal(f.writes, 0);
  });
  it('should retain a prepared assessment summary when configuration provenance changes', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    assert.equal(
      (await f.run({ operation: 'publish', digest }, 'turn', 'f'.repeat(64))).status,
      'published',
    );
    assert.equal(f.writes, 1);
  });
  it('rejects lost authority and a different assessment turn without changing readiness', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    assert.equal((await f.run({ operation: 'publish', digest }, 'other-turn')).status, 'blocked');
    f.revoke();
    assert.equal((await f.run({ operation: 'publish', digest })).status, 'blocked');
    assert.equal(f.writes, 0);
    assert.equal(f.record.phase, 'complete');
  });
  it('supersedes an unattempted revision and never publishes its stale draft', async () => {
    const f = fixture();
    f.retain();
    const oldDigest = await f.compose();
    f.retain({ ...f.result, fullAssessment: 'A deliberately revised complete private plan.' });
    const digest = await f.compose();
    assert.notEqual(digest, oldDigest);
    assert.equal(f.record.assessmentSummaries?.length, 1);
    assert.equal((await f.run({ operation: 'publish', digest: oldDigest })).status, 'blocked');
    assert.equal((await f.run({ operation: 'publish', digest })).status, 'published');
    assert.equal(f.writes, 1);
  });
  it('reconciles an uncertain old revision before composing the replacement', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    f.lose();
    await f.run({ operation: 'publish', digest });
    f.retain({ ...f.result, fullAssessment: 'A revised plan.' });
    assert.equal((await f.run({ operation: 'compose' })).status, 'reconcile-required');
    assert.equal((await f.run({ operation: 'reconcile' })).status, 'published');
    assert.equal((await f.run({ operation: 'compose' })).status, 'composition-ready');
    assert.equal(f.record.assessmentSummaries?.length, 2);
  });
  it('rejects a summary bound to another issue without changing the private plan', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    f.record.assessmentSummaries![0]!.binding = {
      ...f.record.assessmentSummaries![0]!.binding,
      subjectId: 'other-issue',
    };
    const blocked = await f.run({ operation: 'publish', digest });
    assert.ok('code' in blocked && blocked.code === 'assessment-summary-binding-mismatch');
    assert.equal(f.writes, 0);
    assert.deepEqual(f.record.result, f.result);
  });
  it('bounds revision history without deleting receipts or blocking assessment readiness', async () => {
    const f = fixture();
    f.retain();
    const digest = await f.compose();
    await f.run({ operation: 'publish', digest });
    const published = f.record.assessmentSummaries![0]!;
    f.record.assessmentSummaries = Array.from({ length: 32 }, (_, index) => ({
      ...structuredClone(published),
      revision: index + 1,
    }));
    f.record.assessmentRevision = 32;
    f.retain({ ...f.result, fullAssessment: 'A thirty-third deliberate revision.' });
    const blocked = await f.run({ operation: 'compose' });
    assert.ok('code' in blocked && blocked.code === 'assessment-summary-history-full');
    assert.equal(f.record.phase, 'complete');
    assert.equal(f.record.assessmentSummaries.length, 32);
    assert.equal(f.writes, 1);
  });
  it('rejects secrets and private plan as an automatic fallback', async () => {
    const f = fixture();
    f.retain();
    const composed = await f.run({ operation: 'compose' });
    assert.ok('digest' in composed);
    assert.equal(
      (
        await f.run({
          operation: 'candidate',
          digest: composed.digest,
          publicText: 'TOKEN=private',
        })
      ).status,
      'blocked',
    );
    assert.equal(f.writes, 0);
    assert.equal(f.record.assessmentSummaries?.[0]?.publicText, undefined);
    const privateCopy = await f.run({
      operation: 'candidate',
      digest: composed.digest,
      publicText: f.result.fullAssessment,
    });
    assert.ok(
      'code' in privateCopy && privateCopy.code === 'assessment-summary-private-plan-rejected',
    );
  });
});
