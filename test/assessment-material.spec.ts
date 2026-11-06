import assert from 'node:assert/strict';

import assessmentMaterial from '../agent/assessment-material.ts';
import type { ImplementationMaterialRead } from '../agent/implementation-material.ts';
import assessmentContextFixture, {
  hostedAssessmentContextFixture,
} from './assessment-material-fixture.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

describe('agent/assessment-material', () => {
  it('should deliver ordinary hosted assessment metadata without growing the page index past its budget', async () => {
    const source = hostedAssessmentContextFixture();
    const snapshot = structuredClone(source);
    const request = { action: 'context', id: source.id };
    const delivered = assessmentMaterial(source, request);
    const restored = await hydrateImplementation(delivered, async (next) =>
      assessmentMaterial(
        {
          ...source,
          evidence: { ...source.evidence, observedAt: 2 },
          assessment: { ...source.assessment, observedAt: 2 },
        },
        request,
        next.material as ImplementationMaterialRead,
      ),
    );
    assert.deepEqual(restored, snapshot);
    assert.deepEqual(source, snapshot);
  });
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should deliver complete assessment instructions and schema through bounded ${runtime} pages`, async () => {
      const source = assessmentContextFixture(runtime);
      const snapshot = JSON.stringify(source);
      const request = { action: 'context', id: source.id };
      const delivered = assessmentMaterial(source, request);
      const restored = await hydrateImplementation(delivered, async (next) =>
        assessmentMaterial(source, request, next.material as ImplementationMaterialRead),
      );
      assert.deepEqual(restored, JSON.parse(snapshot));
      assert.equal(JSON.stringify(source), snapshot);
      assert.ok('contextMaterials' in delivered && delivered.contextMaterials);
      assert.ok(delivered.contextMaterials.fields.length > 0);
    });
  }
});
