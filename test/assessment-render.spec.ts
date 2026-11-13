import composeResponseBlocks from '../channels/github/presentation/response-blocks.ts';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SharedDispatchRecord } from '../agent/tasks/dispatch/dispatch-state.ts';

import renderNativeAssessment, {
  assessmentPresentationRequest,
  renderBoundAssessment,
} from '../agent/tasks/assessment/assessment-render.ts';
import type { AssessmentSubmission } from '../agent/tasks/assessment/assessment-result.ts';
import assessmentReviewContext from '../agent/tasks/assessment/assessment-review-context.ts';
import AssessmentValidationError from '../agent/tasks/assessment/assessment-validation.ts';
import { runCodexDispatch } from '../agent/tasks/dispatch/codex-dispatch.ts';
import codexRuntimeRequest from '../agent/codex-runtime-request.ts';
import implementationMaterial, {
  type ImplementationMaterialRead,
} from '../agent/tasks/implementation/implementation-material.ts';
import OpenClawDispatch from '../agent/tasks/dispatch/openclaw-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

const target = 'https://github.com/owner/repo/issues/3';
const result: AssessmentSubmission = {
  outcome: 'plan-ready',
  summary: 'Make it easier to resume a task.',
  reviewSummary:
    'You can resume the task from the current conversation without an old plan replacing your changes.',
};

describe('agent/assessment-render', () => {
  for (const runtime of ['codex', 'openclaw'] as const)
    for (const managed of [false, true])
      it(`should render ${runtime} ${managed ? 'managed' : 'direct'} questions from configuration without stale skill metadata`, async () => {
        const owner = {
          id: 'd'.repeat(64),
          threadId: 'thread',
          request: { key: 'issue' },
          manualIssue: {
            repository: { owner: { login: 'owner' }, name: 'repo' },
            issue: { number: 3 },
            selections: { assessment: { skill: 'task:override' } },
          },
          assessment: {
            version: 1,
            observedAt: 1,
            requestedSkill: 'stale:skill',
            defaultSkill: false,
            skill: {
              name: 'stale:skill',
              path: '/stale/SKILL.md',
              scope: 'user',
              digest: 'a'.repeat(64),
            },
          },
        } as SharedDispatchRecord;
        const before = structuredClone(owner);
        const request = {
          action: 'assessment',
          operation: 'render',
          target,
          result: {
            summary: 'Choose a subject.',
            outcome: 'clarification-needed',
            questions: ['Which subject?'],
            reviewSummary: 'Choose a subject.',
          },
        };
        const renderContext = {
          runtime,
          records: managed ? [owner] : [],
          admitted: [],
          session: 'thread',
          workspace: '/workspace',
          debug: true,
          workflow: {
            assessment: { skill: 'configured:assess', guidance: { file: 'unavailable.md' } },
          },
        };
        const shown = await renderBoundAssessment(request, renderContext);
        assert.equal(shown.status, 'formatted');
        assert.ok('responseBlocks' in shown);
        assert.match(String(composeResponseBlocks(shown.responseBlocks)), /Which subject/);
        assert.match(
          String(composeResponseBlocks(shown.responseBlocks)),
          managed ? /task:override/ : /configured:assess/,
        );
        assert.match(String(composeResponseBlocks(shown.responseBlocks)), /unavailable.md/);
        assert.doesNotMatch(JSON.stringify(shown), /⚠️ Warning|stale:skill/);
        assert.equal('contextLimitations' in shown, false);
        assert.deepEqual(owner, before);
        if (managed) {
          await assert.rejects(
            renderBoundAssessment(
              { ...request, target: 'https://github.com/owner/repo/issues/99' },
              renderContext,
            ),
            /assessment-managed-target-mismatch/,
          );
          await assert.rejects(
            renderBoundAssessment(request, {
              ...renderContext,
              records: [{ ...owner, reset: {} } as SharedDispatchRecord],
            }),
            /assessment-managed-context-invalid/,
          );
        }
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
                outcome,
                summary: 'Choose a subject.',
                reviewSummary: 'Choose a subject before writing.',
                questions: ['What subject should the haiku cover?'],
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
          renderNativeAssessment(omittedId, runtime, {
            workspace: renderContext.workspace,
            debug: renderContext.debug,
            workflow: renderContext.workflow,
          }),
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
        assert.match(composeResponseBlocks(shown.responseBlocks), /Model routing/);
        assert.match(composeResponseBlocks(shown.responseBlocks), /provider\/model/);
        assert.match(composeResponseBlocks(shown.responseBlocks), /Auto mode decision/);
        assert.match(
          composeResponseBlocks(shown.responseBlocks),
          outcome === 'plan-ready'
            ? /Assessment instructions/
            : /What subject should the haiku cover/,
        );
        if (outcome === 'clarification-needed')
          assert.doesNotMatch(composeResponseBlocks(shown.responseBlocks), /Debug/);
        else {
          assert.match(composeResponseBlocks(shown.responseBlocks), /configured:work/);
          assert.match(composeResponseBlocks(shown.responseBlocks), /configured:reply/);
          assert.equal(
            composeResponseBlocks(shown.responseBlocks).match(/## 🔬 Debug/g)?.length,
            1,
          );
          assert.ok(
            composeResponseBlocks(shown.responseBlocks).indexOf('## 🔬 Debug') >
              composeResponseBlocks(shown.responseBlocks).indexOf('Auto mode decision'),
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
        result: { ...result, reviewSummary: 'Review detail. '.repeat(10) },
      };
      const first = renderNativeAssessment(request, runtime, metadata);
      const restored = await hydrateImplementation(first, async (read) =>
        renderNativeAssessment({ ...request, ...read }, runtime, metadata),
      );
      assert.match(composeResponseBlocks(restored.responseBlocks as unknown[]), /provider\/model/);
      assert.match(
        composeResponseBlocks(restored.responseBlocks as unknown[]),
        /Shared behavior needs investigation/,
      );
      assert.match(
        composeResponseBlocks(restored.responseBlocks as unknown[]),
        /Not independently verified/,
      );
      assert.match(
        composeResponseBlocks(restored.responseBlocks as unknown[]),
        /company:assessment/,
      );
      assert.ok(
        composeResponseBlocks(restored.responseBlocks as unknown[]).indexOf('## 🔬 Debug') >
          composeResponseBlocks(restored.responseBlocks as unknown[]).lastIndexOf('Review detail.'),
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
      assert.match(composeResponseBlocks(quiet.responseBlocks), /Model routing/);
      assert.doesNotMatch(composeResponseBlocks(quiet.responseBlocks), /company:assessment|Debug/);
    });

  it('should validate complete native input and return only the concise visible review', () => {
    const response = renderNativeAssessment({ ...assessmentPresentationRequest(target), result });
    assert.equal(response.status, 'formatted');
    assert.equal(response.retained, false);
    assert.equal('assessment' in response, false);
    assert.ok(composeResponseBlocks(response.responseBlocks).includes(result.reviewSummary!));
    assert.doesNotMatch(composeResponseBlocks(response.responseBlocks), /saved for implementation/);
    assert.match(composeResponseBlocks(response.responseBlocks), /> ## 🧭/);
  });

  it('should keep direct assessment presentation separate from implementation permission', () => {
    const response = renderNativeAssessment({
      ...assessmentPresentationRequest(target, true),
      result: { ...result, decision: { mode: 'work', reasons: ['Technically ready.'] } },
    });
    assert.equal(response.status, 'formatted');
    assert.match(composeResponseBlocks(response.responseBlocks), /Assessment only/);
    assert.doesNotMatch(composeResponseBlocks(response.responseBlocks), /Continue automatically/);
  });

  it('should keep questions visible without a waiting record', () => {
    const response = renderNativeAssessment({
      ...assessmentPresentationRequest(target),
      result: {
        outcome: 'clarification-needed',
        summary: 'Choose the scope.',
        reviewSummary: 'We need to choose which experience to support.',
        questions: ['Should existing tasks keep their current settings?'],
      },
    });
    assert.equal(response.status, 'formatted');
    assert.equal(response.retained, false);
    assert.match(
      composeResponseBlocks(response.responseBlocks),
      /Should existing tasks keep their current settings/,
    );
  });

  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should render complete clarification without a separate review summary in ${runtime}`, () => {
      const question = 'What should the haiku be about?';
      const response = renderNativeAssessment(
        {
          ...assessmentPresentationRequest(target),
          result: {
            outcome: 'clarification-needed',
            summary: 'Choose a subject.',
            questions: [question],
          },
        },
        runtime,
      );
      assert.equal(response.status, 'formatted');
      assert.equal(response.retained, false);
      assert.ok(composeResponseBlocks(response.responseBlocks).includes('Clarification needed'));
      assert.ok(composeResponseBlocks(response.responseBlocks).includes(question));
    });

  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should preserve oversized ${runtime} cards without a cross-runtime cutoff`, () => {
      const source = {
        outcome: 'clarification-needed',
        summary: 'Choose the scope.',
        questions: Array.from({ length: 5 }, (_, i) => `Question ${i}: ` + 'detail '.repeat(2000)),
      };
      const request = { ...assessmentPresentationRequest(target), result: source };
      const before = structuredClone(request);
      const response = renderNativeAssessment(request, runtime);
      assert.equal(response.status, 'formatted');
      assert.equal(response.retained, false);
      assert.equal('contextMaterials' in response, false);
      assert.equal('next' in response, false);
      assert.equal('presentation' in response, false);
      for (const question of source.questions)
        assert.ok(composeResponseBlocks(response.responseBlocks).includes(question));
      assert.deepEqual(request, before);
      assert.throws(
        () =>
          renderNativeAssessment(
            { ...request, material: { path: ['presentation'], offset: 0 } },
            runtime,
          ),
        /assessment-render-request-invalid/,
      );
    });

  it('should reject missing summary and comment destinations', () => {
    const request = assessmentPresentationRequest(target);
    for (const invalid of [
      { ...request, result: { ...result, summary: undefined } },
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
      [{ ...request, includeDetails: true }, 'request'],
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
          invoke({ ...request, result: { ...result, summary: '' } }),
          (error: unknown) => {
            assert.ok(error instanceof AssessmentValidationError);
            assert.deepEqual(error.recovery.fields, ['request.result.summary']);
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
