import assert from 'node:assert/strict';
import { providerDiagnostic } from '../utils/provider-diagnostic.ts';
import assessmentSummary, {
  assessmentSummaryOwnPublications,
} from '../agent/assessment-summary.ts';
import recordDispatchResult from '../agent/dispatch-result.ts';
import { automationHash } from '../agent/automation-hash.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import type { AssessmentSummaryRequest } from '../agent/assessment-summary-state.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { intakeFixture } from './github-intake-fixture.ts';

export default function fixture(runtime: 'openclaw' | 'codex' = 'openclaw') {
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
    reviewSummary:
      'You would see the result immediately. Docs and tests will explain and verify it.',
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
    requestedSkill: 'agent-system-github-reply',
    defaultSkill: true,
    skill: {
      name: 'agent-system-github-reply',
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
    changed = false,
    rejectWrite = false;
  let receipt: { nodeId: string; databaseId: number; body: string } | undefined;
  const run = (
    action: AssessmentSummaryRequest,
    turnId = 'turn',
    authorityDigest = 'e'.repeat(64),
    recovery = false,
  ) =>
    assessmentSummary({
      runtime,
      record,
      intake,
      action,
      turnId,
      recovery,
      authorityDigest,
      presentation: result.reviewSummary,
      authorize: async () => {
        if (forbidden) throw new Error('native-approval-denied');
      },
      select: async () => ({
        ...selection,
        skill: { ...selection.skill, digest: (changed ? 'f' : 'd').repeat(64) },
      }),
      connect: async () => ({
        authorLogin: 'posting-agent',
        client: {
          findOwnIssueComment: async () => receipt,
          createIssueComment: async (_owner, _repo, number, body) => {
            assert.equal(number, 3);
            writes++;
            if (rejectWrite)
              throw Object.assign(new Error('github-request-rejected'), {
                providerDiagnostic: providerDiagnostic('github', 'api-request', 'permission', {
                  httpStatus: 403,
                }),
              });
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
    rejectWrite: (value: boolean) => {
      rejectWrite = value;
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
