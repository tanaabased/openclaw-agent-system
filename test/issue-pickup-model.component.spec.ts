import assessmentMaterial from '../agent/assessment-material.ts';
import type { ImplementationMaterialRead } from '../agent/implementation-material.ts';
import { issuePickupScenario } from '../examples/openclaw-project-picker/model-fixture.ts';
import { hostedAssessmentContextFixture } from './assessment-material-fixture.ts';
import nativeMaterialFixture from './native-material-fixture.ts';

describe('issue pickup model transport', () => {
  it('should deliver the complete assessment through native codex without tool-output truncation', async () => {
    const context = hostedAssessmentContextFixture();
    const request = { action: 'context', id: context.id };
    await nativeMaterialFixture({
      request,
      run: (input) =>
        assessmentMaterial(context, request, input.material as ImplementationMaterialRead),
      scenario: issuePickupScenario,
      prompt: `Call agent_system_dispatch with action context and id ${context.id}`,
      finalText: 'Should disposable issues close after evidence capture?',
    });
  });
});
