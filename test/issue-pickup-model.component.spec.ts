import assert from 'node:assert/strict';

import assessmentMaterial from '../agent/assessment-material.ts';
import openclawTurnContext from '../agent/openclaw-turn-context.ts';
import type { OpenClawDispatchRecord } from '../agent/openclaw-dispatch-state.ts';
import {
  implementationMaterialSize,
  type ImplementationMaterialRead,
} from '../agent/implementation-material.ts';
import { hostedAssessmentContextFixture } from './assessment-material-fixture.ts';
import { issuePickupScenario } from '../examples/openclaw-project-picker/model-fixture.ts';
import nativeMaterialFixture from './native-material-fixture.ts';

describe('issue pickup model transport', () => {
  it('should deliver context above the former cutoff intact through the native host', async () => {
    const context = {
      ...hostedAssessmentContextFixture(),
      project: { path: '/workspace/' + 'nested/'.repeat(400) },
    };
    const request = { action: 'context', id: context.id };
    const response = assessmentMaterial(context, request);
    assert.ok(implementationMaterialSize(response) > 10000);
    await nativeMaterialFixture({
      request,
      run: (input) =>
        assessmentMaterial(context, request, input.material as ImplementationMaterialRead),
      verify: (complete) => {
        assert.equal(complete.status, 'verified');
        assert.deepEqual(complete.project, context.project);
        assert.deepEqual(complete.presentationRequest, context.presentationRequest);
        assert.equal(complete.instructions, context.instructions);
      },
      minimumPages: 0,
    });
  });
  it('should deliver assessment source references through native codex without tool-output truncation', async () => {
    const context = hostedAssessmentContextFixture();
    const request = { action: 'context', id: context.id };
    const turn = openclawTurnContext(
      {
        id: context.id,
        threadId: 'issue',
        request: { key: 'issue', agentId: 'receiver' },
        sessionCreation: { verified: true, sessionId: 'incarnation' },
      } as OpenClawDispatchRecord,
      { agentId: 'receiver', sessionKey: 'issue', sessionId: 'incarnation', runId: 'assessment' },
    )!;
    let sourceReads = 0;
    await nativeMaterialFixture({
      request,
      run: (input, tool) => {
        if (tool === 'agent_system_github') {
          sourceReads++;
          assert.deepEqual(input.argv, [
            'issue',
            'view',
            context.evidence.source,
            '--json',
            'title,body,comments',
          ]);
          return {
            exitCode: 0,
            truncated: false,
            stdout: JSON.stringify({
              title: 'Cleanup',
              body: 'Clarify when disposable issues close.',
              comments: [],
            }),
          };
        }
        const result = assessmentMaterial(
          context,
          request,
          input.material as ImplementationMaterialRead,
        );
        assert.ok('evidence' in result);
        assert.deepEqual(result.evidence, { source: context.evidence.source });
        assert.equal('contextMaterials' in result, false);
        return result;
      },
      minimumPages: 0,
      scenario: issuePickupScenario,
      prompt: `New issue assigned: clarify cleanup.\n\n${turn.appendContext}`,
      finalText: 'Should disposable issues close after evidence capture?',
    });
    assert.equal(sourceReads, 1);
  });
});
