import assert from 'node:assert/strict';

import implementationContext from '../agent/implementation-context.ts';
import implementationMaterial, {
  type ImplementationMaterialRead,
  implementationContextBudget,
} from '../agent/implementation-material.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

const original = () => {
  const text = 'Full engineering source: \\ "\n 🧭\u0000 '.repeat(700);
  return {
    ...implementationContext({
      runtime: 'openclaw',
      id: 'a'.repeat(64),
      path: '/task/worktree',
      assessment: {
        version: 1,
        outcome: 'plan-ready',
        summary: 'Bound delivery.',
        assessment: 'Repair.',
        plan: text,
        fullAssessment: text,
        evidence: [],
        progress: { completed: [], remaining: [] },
      },
      previousResult: {
        outcome: 'blocked',
        summary: 'Interrupted.',
        fullResult: 'Distinct retained blocker.\n'.repeat(1500),
      },
      scope: 'local',
    }),
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
  it('should reproduce oversized raw context and retrieve every distinct value exactly', async () => {
    const source = original();
    const snapshot = JSON.stringify(source);
    assert.ok(snapshot.length > 64000);
    assert.throws(() => JSON.parse(snapshot.slice(0, 64000)), SyntaxError);
    const delivered = implementationMaterial(source, request);
    assert.equal(delivered.status, 'verified');
    assert.ok('handoff' in delivered);
    assert.ok('resultSchema' in delivered);
    assert.ok('implementation' in delivered);
    assert.equal('publicationAuthorized' in delivered && delivered.publicationAuthorized, false);
    const restored = await hydrateImplementation(delivered, async (next) =>
      implementationMaterial(source, request, next.material as ImplementationMaterialRead),
    );
    assert.deepEqual(restored, JSON.parse(snapshot));
    assert.equal(JSON.stringify(source), snapshot);
    const fields = 'contextMaterials' in delivered ? delivered.contextMaterials?.fields : [];
    assert.ok(fields?.some(({ path }) => path.join('.') === 'assessment.plan'));
    assert.ok(
      !fields?.some(
        ({ path }) =>
          path.join('.') === 'assessment.fullAssessment' ||
          path.join('.') === 'plan' ||
          path[0] === 'previousImplementationResult',
      ),
    );
  });

  it('should preserve a distinct full assessment and return independent complete json pages', async () => {
    const source = original();
    source.assessment!.fullAssessment = 'Additional decision and evidence.\n'.repeat(800);
    const response = implementationMaterial(source, request);
    const restored = await hydrateImplementation(response, async (next) => {
      const page = implementationMaterial(
        source,
        request,
        next.material as ImplementationMaterialRead,
      );
      assert.equal(JSON.parse(JSON.stringify(page)).status, 'material');
      return page;
    });
    assert.deepEqual(restored, JSON.parse(JSON.stringify(source)));
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
      plan: 'Implement.',
    });
    assert.deepEqual(implementationMaterial(source, request), source);
    assert.throws(
      () =>
        implementationMaterial(
          { ...source, instructions: 'x'.repeat(implementationContextBudget) },
          request,
        ),
      /implementation-context-controls-too-large/,
    );
  });
});
