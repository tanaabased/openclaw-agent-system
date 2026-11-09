import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import renderNativeAssessment, {
  assessmentPresentationRequest,
  renderBoundAssessment,
} from '../agent/assessment-render.ts';
import assessmentReviewContext from '../agent/assessment-review-context.ts';
import implementationMaterial, {
  type ImplementationMaterialRead,
} from '../agent/implementation-material.ts';
import { runCodexDispatch } from '../agent/codex-dispatch.ts';
import codexRuntimeRequest from '../agent/codex-runtime-request.ts';
import OpenClawDispatch from '../agent/openclaw-dispatch.ts';
import type { AssessmentSubmission } from '../agent/assessment-result.ts';
import hydrateImplementation from './implementation-material-fixture.ts';
import type { AgentManifest } from '../manifest/types.ts';
import AssessmentValidationError from '../agent/assessment-validation.ts';

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
    it(`should format ${runtime} input without boilerplate while preserving substantive requirements`, () => {
      const unversioned: Record<string, unknown> = { ...result };
      delete unversioned.version;
      delete unversioned.evidence;
      delete unversioned.progress;
      const request = { ...assessmentPresentationRequest(target), result: unversioned };
      const formatted = renderNativeAssessment(request, runtime);
      assert.equal(formatted.status, 'formatted');
      assert.ok(!('version' in request.result));
      assert.throws(() =>
        renderNativeAssessment({ ...request, result: { ...unversioned, version: 2 } }, runtime),
      );
      for (const invalid of [
        { evidence: null },
        { evidence: [{}] },
        { progress: null },
        { progress: { completed: [] } },
      ])
        assert.throws(() =>
          renderNativeAssessment({ ...request, result: { ...unversioned, ...invalid } }, runtime),
        );
      const withoutPlan = { ...unversioned };
      delete withoutPlan.plan;
      assert.throws(
        () => renderNativeAssessment({ ...request, result: withoutPlan }, runtime),
        /request.result.plan/,
      );
      const question = {
        ...withoutPlan,
        outcome: 'clarification-needed',
        questions: ['Which subject?'],
        decision: { mode: 'plan', reasons: ['Subject missing.'] },
      };
      const asked = renderNativeAssessment({ ...request, result: question }, runtime);
      assert.ok('presentation' in asked);
      assert.match(String(asked.presentation), /Which subject/);
      assert.match(String(asked.presentation), /Waiting for the missing answers/);
      assert.doesNotMatch(String(asked.presentation), /Await your direction/);
      assert.throws(
        () =>
          renderNativeAssessment({ ...request, result: { ...question, questions: [] } }, runtime),
        /questions/,
      );
    });

  for (const runtime of ['codex', 'openclaw'] as const)
    for (const outcome of ['plan-ready', 'clarification-needed'] as const)
      it(`should recover a missing ${outcome} review in ${runtime} without saving a plan or gating work`, async () => {
        const record = {
          id: 'd'.repeat(64),
          routing: JSON.stringify({
            selection: { model: 'provider/model', effort: 'medium' },
            complexity: 'low',
            profile: 'low',
            source: 'native',
            reason: 'Bounded poem.',
          }),
          effective: { status: 'verified' as const, model: 'provider/model', effort: 'medium' },
          assessment: {
            version: 1 as const,
            observedAt: 1,
            requestedSkill: 'company:assessment',
            defaultSkill: false,
            skill: {
              name: 'company:assessment',
              path: '/skills/assessment/SKILL.md',
              scope: 'user' as const,
              digest: 'a'.repeat(64),
            },
          },
          implementationDecision: {
            mode: outcome === 'plan-ready' ? ('work' as const) : ('plan' as const),
            reasons: [outcome === 'plan-ready' ? 'All choices supplied.' : 'Subject is missing.'],
          },
        };
        const before = structuredClone(record);
        const initialReview = assessmentReviewContext(record, target);
        assert.equal('cards' in initialReview.presentationRequest, false);
        const owner = {
          ...record,
          threadId: 'thread',
          request: { key: 'issue' },
          worktree: '/checkout',
          context: JSON.stringify({ source: target }),
          manualIssue: {
            repository: { owner: { login: 'owner' }, name: 'repo' },
            issue: { number: 3 },
          },
        } as SharedDispatchRecord;
        const context = { runtime, status: 'verified', publicationAuthorized: true, initialReview };
        const request = { action: 'context', id: 'task' };
        const restored = await hydrateImplementation(
          implementationMaterial(context, request),
          async (read) =>
            implementationMaterial(context, request, read.material as ImplementationMaterialRead),
        );
        assert.equal(restored.status, 'verified');
        assert.equal(restored.publicationAuthorized, true);
        assert.deepEqual(restored.initialReview, initialReview);
        const submitted =
          outcome === 'plan-ready'
            ? result
            : {
                version: 1,
                outcome,
                summary: 'Choose a subject.',
                assessment: 'Haiku form is known.',
                fullAssessment: 'The subject is the only missing choice.',
                reviewSummary: 'Choose a subject before writing.',
                questions: ['What subject should the haiku cover?'],
                evidence: [],
                progress: { completed: [], remaining: [] },
              };
        const renderContext = {
          runtime,
          records: [owner],
          admitted: [],
          session: 'thread',
          workspace: '/workspace',
          debug: outcome === 'plan-ready',
          workflow: {
            implementation: { skill: 'configured:work' },
            feedback: { skill: 'configured:reply' },
          },
        };
        const renderRequest = {
          ...initialReview.presentationRequest,
          result: { ...submitted, decision: initialReview.decision },
        };
        await assert.rejects(
          renderBoundAssessment({ ...renderRequest, cards: ['forged'] }, renderContext),
          /assessment-render-request-invalid/,
        );
        const shown = await renderBoundAssessment(renderRequest, renderContext);
        const unsaved = { ...owner, assessment: undefined };
        const beforeContext = structuredClone(unsaved);
        assert.deepEqual(
          await renderBoundAssessment(renderRequest, {
            ...renderContext,
            records: [unsaved],
            nativeContext: async (bound) => {
              assert.equal(bound?.id, owner.id);
              return { assessment: record.assessment, workspace: '/workspace' };
            },
          }),
          shown,
          'managed cards must not depend on saving a context lookup',
        );
        assert.deepEqual(unsaved, beforeContext);
        const omittedId: Record<string, unknown> = { ...renderRequest };
        const boundRequest: Record<string, unknown> = { ...renderRequest };
        delete boundRequest.target;
        assert.deepEqual(await renderBoundAssessment(boundRequest, renderContext), shown);
        await assert.rejects(
          () => renderBoundAssessment({ ...renderRequest, id: owner.id }, renderContext),
          /assessment-render-request-invalid/,
        );
        for (const changed of [
          { retired: { at: 1 } },
          { reset: { at: 1 } },
          { supersededBy: 'another-task' },
          { retirement: { at: 1 } },
        ])
          await assert.rejects(
            () =>
              renderBoundAssessment(omittedId, {
                ...renderContext,
                records: [{ ...owner, ...changed } as SharedDispatchRecord],
              }),
            /assessment-managed-context-invalid/,
          );
        assert.deepEqual(
          await renderBoundAssessment(omittedId, { ...renderContext, records: [] }),
          renderNativeAssessment(omittedId, runtime),
        );
        await assert.rejects(
          () =>
            renderBoundAssessment(
              { ...renderRequest, id: owner.id },
              { ...renderContext, records: [] },
            ),
          /assessment-render-request-invalid/,
        );
        assert.ok(shown.status === 'formatted');
        assert.match(shown.presentation, /Model routing/);
        assert.match(shown.presentation, /provider\/model/);
        assert.match(shown.presentation, /Auto mode decision/);
        assert.match(
          shown.presentation,
          outcome === 'plan-ready'
            ? /Assessment instructions/
            : /What subject should the haiku cover/,
        );
        if (outcome === 'clarification-needed') assert.doesNotMatch(shown.presentation, /Debug/);
        else {
          assert.match(shown.presentation, /configured:work/);
          assert.match(shown.presentation, /configured:reply/);
          assert.equal(shown.presentation.match(/## 🔬 Debug/g)?.length, 1);
          assert.ok(
            shown.presentation.indexOf('## 🔬 Debug') >
              shown.presentation.indexOf('Auto mode decision'),
          );
        }
        assert.equal(shown.retained, false);
        assert.deepEqual(record, before);
        assert.equal('result' in record, false);
      });
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
        ...assessmentPresentationRequest(target),
        result: { ...result, reviewSummary: 'Review detail. '.repeat(900) },
      };
      const first = renderNativeAssessment(request, runtime, metadata);
      const restored = await hydrateImplementation(first, async (read) =>
        renderNativeAssessment({ ...request, ...read }, runtime, metadata),
      );
      assert.match(String(restored.presentation), /provider\/model/);
      assert.match(String(restored.presentation), /Shared behavior needs investigation/);
      assert.match(String(restored.presentation), /Not independently verified/);
      assert.match(String(restored.presentation), /company:assessment/);
      assert.ok(
        String(restored.presentation).indexOf('## 🔬 Debug') >
          String(restored.presentation).lastIndexOf('Review detail.'),
      );
      const quiet = renderNativeAssessment(
        {
          ...assessmentPresentationRequest(target),
          result,
        },
        runtime,
        { ...metadata, debug: false },
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

  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should render complete clarification without a separate review summary in ${runtime}`, () => {
      const question = 'What should the haiku be about?';
      const response = renderNativeAssessment(
        {
          ...assessmentPresentationRequest(target),
          result: {
            version: 1,
            outcome: 'clarification-needed',
            summary: 'Choose a subject.',
            assessment: 'The form is already known.',
            fullAssessment: 'A haiku is requested. Its subject remains undecided.',
            questions: [question],
            evidence: [],
            progress: { completed: ['Selected haiku.'], remaining: ['Choose subject.'] },
          },
        },
        runtime,
      );
      assert.equal(response.status, 'formatted');
      assert.equal(response.retained, false);
      assert.ok(response.presentation.includes('Clarification needed'));
      assert.ok(response.presentation.includes(question));
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

  it('should identify malformed render envelope fields without exposing their values', () => {
    const request = { ...assessmentPresentationRequest(target), result };
    for (const [input, field] of [
      [{ ...request, target: undefined }, 'request.target'],
      [{ ...request, operation: 'PRIVATE-OPERATION' }, 'request.operation'],
      [{ ...request, includeDetails: true }, 'request.includeDetails'],
      [{ ...request, id: 'PRIVATE-ID' }, 'request'],
    ] as const)
      assert.throws(
        () => renderNativeAssessment(input),
        (error: unknown) => {
          assert.ok(error instanceof AssessmentValidationError);
          assert.deepEqual(error.recovery.fields, [field]);
          assert.doesNotMatch(error.message + JSON.stringify(error.recovery), /PRIVATE-/);
          return true;
        },
      );
  });

  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should format unbound ${runtime} input without opening a journal or resolving execution dependencies`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'assessment-render-'));
      const dependencies = new Proxy(
        {},
        {
          get(_target, key) {
            if (key === 'inspectBinding') return async () => ({ status: 'unbound', path: root });
            throw new Error('unexpected runtime dependency');
          },
        },
      );
      try {
        const invoke = (request: object) =>
          runtime === 'codex'
            ? runCodexDispatch(root, 'assessment', request, dependencies)
            : new OpenClawDispatch(dependencies as never).run(
                {} as AgentManifest,
                root,
                {} as never,
                request as never,
              );
        const request = { ...assessmentPresentationRequest(target), result };
        const snapshot = structuredClone(request);
        await assert.rejects(
          invoke({ ...request, result: { ...result, progress: { completed: [] } } }),
          (error: unknown) => {
            assert.ok(error instanceof AssessmentValidationError);
            assert.deepEqual(error.recovery.fields, ['request.result.progress.remaining']);
            assert.equal(error.code, 'assessment-render-request-invalid');
            return true;
          },
        );
        const response = await invoke(request);
        assert.ok(response && 'status' in response);
        assert.equal(response.status, 'formatted');
        assert.deepEqual(await readdir(root), []);
        assert.deepEqual(request, snapshot);
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
