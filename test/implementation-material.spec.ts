import assert from 'node:assert/strict';

import implementationContext from '../agent/implementation-context.ts';
import implementationMaterial, {
  ContextMaterialError,
  type ImplementationMaterialRead,
  implementationContextBudget,
} from '../agent/implementation-material.ts';
import hydrateImplementation from './implementation-material-fixture.ts';
import assessmentMaterial from '../agent/assessment-material.ts';
import workflowFailure from '../agent/workflow-failure.ts';

const original = () => {
  const text = 'Full engineering source: \\ "\n 🧭\u0000 '.repeat(700);
  return {
    ...implementationContext({
      runtime: 'openclaw',
      id: 'a'.repeat(64),
      path: '/task/worktree',
      scope: 'local',
    }),
    previousResult: {
      outcome: 'blocked',
      summary: 'Interrupted.',
      fullResult: 'Distinct retained blocker.\n'.repeat(1500),
    },
    currentRequirements: text,
    previousImplementationResult: {
      outcome: 'blocked',
      summary: 'Interrupted.',
      fullResult: 'Distinct retained blocker.\n'.repeat(1500),
    },
    implementation: {
      skill: { name: 'implement', path: '/skills/implement/SKILL.md' },
      guidance: { content: 'Distinct selected guidance.\n'.repeat(1500) },
    },
    instructions: 'Consume all retained material before implementation.',
    currentIssue: {
      observedAt: 1,
      comments: Array.from({ length: 30 }, (_, i) => ({
        body: String(i) + 'unrelated comment '.repeat(120),
      })),
    },
  };
};
const request = { action: 'implementation-context', id: 'a'.repeat(64) };

describe('agent/implementation-material', () => {
  for (const runtime of ['codex', 'openclaw'] as const)
    it(`should recover an altered context action through the original ${runtime} page requests`, async () => {
      const source = { ...original(), runtime };
      const snapshot = structuredClone(source);
      const delivered = implementationMaterial(source, request);
      assert.ok('contextMaterials' in delivered && delivered.contextMaterials);
      const field = delivered.contextMaterials.fields.find(
        (field) => field.path.join('.') === 'currentRequirements',
      )!;
      assert.ok(field);
      const wrong: Record<string, unknown> = { ...field.request, action: 'context' };
      assert.throws(
        () =>
          assessmentMaterial(
            { runtime, evidence: { source: 'https://github.com/owner/repo/issues/3' } },
            wrong,
            wrong.material as ImplementationMaterialRead,
          ),
        (error: unknown) => {
          assert.ok(error instanceof ContextMaterialError);
          assert.equal(error.code, 'assessment-material-stale');
          const failure = workflowFailure(error, 'fallback');
          assert.match(failure.recovery!.instruction, /request|operation/);
          assert.doesNotMatch(JSON.stringify(failure), /Full engineering source/);
          return true;
        },
      );
      const restored = await hydrateImplementation(delivered, async (next) => {
        assert.equal(next.action, request.action);
        assert.equal(next.id, request.id);
        return implementationMaterial(source, request, next.material as ImplementationMaterialRead);
      });
      assert.deepEqual(restored, source);
      assert.deepEqual(source, snapshot);
    });
  it('should reproduce oversized raw context and retrieve every distinct value exactly', async () => {
    const source = original();
    const snapshot = JSON.stringify(source);
    assert.ok(snapshot.length > 64000);
    assert.throws(() => JSON.parse(snapshot.slice(0, 64000)), SyntaxError);
    const delivered = implementationMaterial(source, request);
    assert.equal(delivered.status, 'verified');
    assert.equal('publicationAuthorized' in delivered && delivered.publicationAuthorized, false);
    const restored = await hydrateImplementation(delivered, async (next) =>
      implementationMaterial(source, request, next.material as ImplementationMaterialRead),
    );
    assert.deepEqual(restored, JSON.parse(snapshot));
    assert.equal(JSON.stringify(source), snapshot);
    const fields = 'contextMaterials' in delivered ? delivered.contextMaterials?.fields : [];
    assert.ok(fields?.some(({ path }) => path.join('.') === 'currentRequirements'));
    assert.ok(
      !fields?.some(
        ({ path }) =>
          path.join('.') === 'assessment.fullAssessment' ||
          path[0] === 'previousImplementationResult',
      ),
    );
  });

  it('should page medium-sized evidence alongside warnings without exceeding the native envelope', async () => {
    const source = {
      ...implementationContext({ runtime: 'openclaw', id: 'a'.repeat(64), path: '/checkout' }),
      instructions: 'Current instructions. '.repeat(250),
      currentIssue: { body: 'Current issue.', comments: [], observedAt: 1 },
      routing: JSON.stringify({ guidance: 'routing information '.repeat(24) }),
      assignmentObservation: { missing: true, detail: 'observation '.repeat(18) },
      assignmentWarning: { summary: 'current warning '.repeat(20) },
      implementation: {
        skill: { name: 'selected', path: '/skills/selected', digest: 'b'.repeat(64) },
        observedAt: 1,
      },
    };
    const first = implementationMaterial(source, request);
    const restored = await hydrateImplementation(first, async (next) =>
      implementationMaterial(source, request, next.material as ImplementationMaterialRead),
    );
    assert.deepEqual(restored, source);
  });

  it('should preserve result aliases regardless of object property order', async () => {
    const { previousImplementationResult, ...current } = original();
    const source = { previousImplementationResult, ...current };
    const response = implementationMaterial(source, request);
    const restored = await hydrateImplementation(response, async (next) =>
      implementationMaterial(source, request, next.material as ImplementationMaterialRead),
    );
    assert.deepEqual(restored, JSON.parse(JSON.stringify(source)));
  });

  it('should reject stale values and invalid offsets without modifying the source', () => {
    const source = original();
    const response = implementationMaterial(source, request);
    assert.ok('contextMaterials' in response && response.contextMaterials);
    const field = response.contextMaterials.fields[0]!;
    const read = field.request.material as ImplementationMaterialRead;
    for (const offset of [-1, 0.5, field.length, Number.MAX_SAFE_INTEGER])
      assert.throws(
        () => implementationMaterial(source, request, { ...read, offset }),
        /implementation-material-range-invalid/,
      );
    assert.throws(
      () => implementationMaterial(source, request, { ...read, digest: 'b'.repeat(64) }),
      /implementation-material-stale/,
    );
    assert.throws(
      () => implementationMaterial(source, request, { ...read, path: ['__proto__', 'value'] }),
      /implementation-material-stale/,
    );
  });

  it('should keep small contexts convenient and refuse oversized mandatory controls explicitly', () => {
    const source = implementationContext({
      runtime: 'codex',
      id: 'a',
      path: '/task',
    });
    assert.equal(implementationMaterial(source, request).status, 'verified');
    assert.throws(
      () =>
        implementationMaterial({ ...source, id: 'x'.repeat(implementationContextBudget) }, request),
      /implementation-context-controls-too-large/,
    );
  });
});
