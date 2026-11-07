import assert from 'node:assert/strict';

import assessmentMaterial from '../agent/assessment-material.ts';
import { assessmentResultFormat } from '../agent/assessment-result.ts';
import type { ImplementationMaterialRead } from '../agent/implementation-material.ts';
import assessmentContextFixture, {
  hostedAssessmentContextFixture,
} from './assessment-material-fixture.ts';
import hydrateImplementation from './implementation-material-fixture.ts';

describe('agent/assessment-material', () => {
  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should deliver ${runtime} source references without bundling or paging the discussion`, () => {
      const base = hostedAssessmentContextFixture();
      const source = {
        ...base,
        runtime,
        evidence: { ...base.evidence, body: 'Full source belongs in GitHub. '.repeat(10000) },
      };
      const snapshot = structuredClone(source);
      const delivered = assessmentMaterial(source, { action: 'context', id: source.id });
      assert.ok('evidence' in delivered);
      assert.deepEqual(delivered.evidence, { source: source.evidence.source });
      assert.equal('contextMaterials' in delivered, false);
      assert.equal('resultSchema' in delivered, false);
      assert.deepEqual(delivered.resultFormat, assessmentResultFormat);
      assert.deepEqual(delivered.effective, source.effective);
      assert.deepEqual(delivered.project, source.project);
      assert.deepEqual(source, snapshot);
    });
  }
  it('should return validated file guidance by path and retain inline guidance completely', async () => {
    const base = assessmentContextFixture();
    const guidance = {
      source: 'file',
      path: '/workspace/guidance.md',
      digest: 'b'.repeat(64),
      content: 'Custom guidance. '.repeat(10000),
    };
    const source = {
      ...base,
      continuationRequest: { action: 'context', id: base.id },
      assessment: { ...base.assessment, guidance },
    };
    const request = { action: 'context', id: source.id };
    const file = assessmentMaterial(source, request);
    assert.equal('contextMaterials' in file, false);
    assert.ok('assessment' in file);
    assert.equal(file.assessment?.guidance?.path, guidance.path);
    assert.equal(file.assessment?.guidance?.digest, guidance.digest);
    assert.equal('content' in file.assessment!.guidance!, false);
    const inline = {
      ...source,
      assessment: { ...source.assessment, guidance: { ...guidance, source: 'inline' } },
    };
    const delivered = assessmentMaterial(inline, request);
    assert.ok('contextMaterials' in delivered);
    assert.deepEqual(delivered.continuationRequest, source.continuationRequest);
    const restored = await hydrateImplementation(delivered, async (next) =>
      assessmentMaterial(inline, request, next.material as ImplementationMaterialRead),
    );
    assert.deepEqual(
      (restored.assessment as typeof inline.assessment).guidance,
      inline.assessment.guidance,
    );
  });
});
