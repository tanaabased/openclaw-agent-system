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
import hydrateImplementation from './implementation-material-fixture.ts';
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
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should retain selected routing and debug cards through native ${runtime} presentation`, async () => {
      const metadata = {
        routing: {
          model: 'provider/model',
          effort: 'high',
          complexity: 'medium' as const,
          profile: 'medium' as const,
          source: 'assessed' as const,
          reason: 'Shared behavior needs investigation.',
        },
        effective: { status: 'unverified' as const },
        assessment: { defaultSkill: false, skill: { name: 'company:assessment' } },
        debug: true,
      };
      const request = {
        ...assessmentPresentationRequest(target, false, metadata),
        result: { ...result, reviewSummary: 'Review detail. '.repeat(900) },
      };
      const first = renderNativeAssessment(request, runtime);
      const restored = await hydrateImplementation(first, async (read) =>
        renderNativeAssessment({ ...request, ...read }, runtime),
      );
      assert.match(String(restored.presentation), /provider\/model/);
      assert.match(String(restored.presentation), /Shared behavior needs investigation/);
      assert.match(String(restored.presentation), /Not independently verified/);
      assert.match(String(restored.presentation), /company:assessment/);
      const quiet = renderNativeAssessment(
        {
          ...assessmentPresentationRequest(target, false, { ...metadata, debug: false }),
          result,
        },
        runtime,
      );
      assert.equal(quiet.status, 'formatted');
      assert.match(quiet.presentation, /Model routing/);
      assert.doesNotMatch(quiet.presentation, /company:assessment|Debug/);
    });

  it('should validate complete native input and return only the concise visible review', () => {
    const response = renderNativeAssessment({ ...assessmentPresentationRequest(target), result });
    assert.equal(response.status, 'formatted');
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
    assert.equal(response.status, 'formatted');
    assert.ok(JSON.stringify(response).length < 2000);
    assert.ok(response.presentation.includes(source.reviewSummary!));
    assert.doesNotMatch(JSON.stringify(response), /engineering details|implementation step/);
  });

  it('should keep direct assessment presentation separate from implementation permission', () => {
    const response = renderNativeAssessment({
      ...assessmentPresentationRequest(target, true),
      result: { ...result, decision: { mode: 'work', reasons: ['Technically ready.'] } },
    });
    assert.equal(response.status, 'formatted');
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
    assert.equal(response.status, 'formatted');
    assert.equal(response.retained, false);
    assert.match(response.presentation, /Should existing tasks keep their current settings/);
  });

  it('should page long clarification text without saving or echoing the engineering plan', async () => {
    const partial = {
      version: result.version,
      summary: result.summary,
      assessment: result.assessment,
      fullAssessment: result.fullAssessment,
      reviewSummary: result.reviewSummary,
      evidence: result.evidence,
      progress: result.progress,
    };
    const source = {
      ...partial,
      outcome: 'clarification-needed',
      questions: Array.from({ length: 5 }, (_, i) => `Question ${i}: ` + 'detail '.repeat(180)),
    };
    const request = { ...assessmentPresentationRequest(target), result: source };
    const first = renderNativeAssessment(request, 'openclaw');
    assert.equal(first.status, 'formatted');
    assert.ok(first.contextMaterials);
    assert.doesNotMatch(JSON.stringify(first), /ENGINEERING-/);
    const restored = await hydrateImplementation(first, async (read) =>
      renderNativeAssessment({ ...request, ...read }, 'openclaw'),
    );
    for (const question of source.questions)
      assert.ok(String(restored.presentation).includes(question));
    assert.equal(restored.retained, false);
    const read = first.contextMaterials.fields[0]!.request;
    assert.throws(
      () =>
        renderNativeAssessment(
          {
            ...request,
            ...read,
            result: { ...source, questions: ['Changed question'] },
          },
          'openclaw',
        ),
      /stale/,
    );
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
