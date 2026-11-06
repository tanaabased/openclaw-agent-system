import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import renderNativeAssessment, {
  assessmentPresentationRequest,
} from '../agent/assessment-render.ts';
import { runCodexDispatch } from '../agent/codex-dispatch.ts';
import codexRuntimeRequest from '../agent/codex-runtime-request.ts';
import OpenClawDispatch from '../agent/openclaw-dispatch.ts';
import type { AssessmentSubmission } from '../agent/assessment-result.ts';
import type { AgentManifest } from '../manifest/types.ts';

const target = 'https://github.com/owner/repo/issues/3';
const result: AssessmentSubmission = {
  version: 1,
  outcome: 'plan-ready',
  summary: 'Make it easier to resume a task.',
  assessment: 'Use current conversation context.',
  fullAssessment:
    'ENGINEERING-SOURCE: inspect owners, preserve constraints and validate both runtimes.',
  plan: 'ENGINEERING-PLAN: change shared owners and verify behavior.',
  reviewSummary:
    'You can resume the task from the current conversation without an old plan replacing your changes.',
  evidence: [],
  progress: { completed: [], remaining: [] },
};

describe('agent/assessment-render', () => {
  it('should validate complete native input and return only the concise visible review', () => {
    const response = renderNativeAssessment({ ...assessmentPresentationRequest(target), result });
    assert.equal(response.status, 'formatted');
    assert.equal(response.retained, false);
    assert.equal('assessment' in response, false);
    assert.doesNotMatch(JSON.stringify(response), /ENGINEERING-/);
    assert.ok(response.presentation.includes(result.reviewSummary!));
    assert.doesNotMatch(response.presentation, /ENGINEERING-|saved for implementation/);
    assert.match(response.presentation, /> ## 🧭/);
  });

  it('should keep a large complete plan in native input without echoing it into tool output', () => {
    const source = {
      ...result,
      fullAssessment: 'engineering details '.repeat(1500),
      plan: 'implementation step '.repeat(1500),
    };
    const snapshot = JSON.stringify(source);
    const response = renderNativeAssessment({
      ...assessmentPresentationRequest(target),
      result: source,
    });
    assert.equal(JSON.stringify(source), snapshot);
    assert.ok(JSON.stringify(response).length < 2000);
    assert.ok(response.presentation.includes(source.reviewSummary!));
    assert.doesNotMatch(JSON.stringify(response), /engineering details|implementation step/);
  });

  it('should keep direct assessment presentation separate from implementation permission', () => {
    const response = renderNativeAssessment({
      ...assessmentPresentationRequest(target, true),
      result: { ...result, decision: { mode: 'work', reasons: ['Technically ready.'] } },
    });
    assert.match(response.presentation, /Assessment only/);
    assert.doesNotMatch(response.presentation, /Continue automatically/);
  });

  it('should keep questions visible without a waiting record', () => {
    const response = renderNativeAssessment({
      ...assessmentPresentationRequest(target),
      result: {
        version: 1,
        outcome: 'clarification-needed',
        summary: 'Choose the scope.',
        assessment: 'Both options are feasible.',
        fullAssessment: 'Complete partial investigation.',
        reviewSummary: 'We need to choose which experience to support.',
        questions: ['Should existing tasks keep their current settings?'],
        evidence: [],
        progress: { completed: [], remaining: [] },
      },
    });
    assert.equal(response.retained, false);
    assert.match(response.presentation, /Should existing tasks keep their current settings/);
  });

  it('should reject missing source, missing review and comment destinations', () => {
    const request = assessmentPresentationRequest(target);
    for (const invalid of [
      { ...request, result: { ...result, fullAssessment: undefined } },
      { ...request, result: { ...result, reviewSummary: undefined } },
      { ...request, result, target: target + '#issuecomment-1' },
      { ...request, result, includeDetails: true },
    ])
      assert.throws(() => renderNativeAssessment(invalid));
  });

  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should format in ${runtime} without opening a journal or resolving runtime dependencies`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'assessment-render-'));
      const dependencies = new Proxy(
        {},
        {
          get() {
            throw new Error('unexpected runtime dependency');
          },
        },
      );
      try {
        const request = { ...assessmentPresentationRequest(target), result };
        const response =
          runtime === 'codex'
            ? await runCodexDispatch(root, 'assessment', request, dependencies)
            : await new OpenClawDispatch(dependencies as never).run(
                {} as AgentManifest,
                root,
                {} as never,
                request,
              );
        assert.ok(response && 'status' in response);
        assert.equal(response.status, 'formatted');
        assert.deepEqual(await readdir(root), []);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

  it('should expose the pure render operation through the codex command contract', () => {
    const parsed = codexRuntimeRequest(
      'dispatch',
      ['assessment', 'render', '--plugin-data', '/private/plugin'],
      { target, result },
    );
    assert.deepEqual(parsed.request, { ...assessmentPresentationRequest(target), result });
  });
});
