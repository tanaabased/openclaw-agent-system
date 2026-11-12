import assert from 'node:assert/strict';

import assessmentMaterial from '../agent/tasks/assessment/assessment-material.ts';
import taskTurnContext from '../agent/tasks/context/task-turn-context.ts';
import openclawTurnContext from '../agent/tasks/context/openclaw-turn-context.ts';
import type { OpenClawDispatchRecord } from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import {
  implementationMaterialSize,
  type ImplementationMaterialRead,
} from '../agent/tasks/implementation/implementation-material.ts';
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
  it('should inspect the issue from injected native context without a bootstrap call', async () => {
    const context = hostedAssessmentContextFixture();
    const request = { action: 'context', id: context.id };
    const record = {
      id: context.id,
      threadId: 'issue',
      request: { key: 'issue', agentId: 'receiver' },
      sessionCreation: { verified: true, sessionId: 'incarnation' },
      worktree: context.project.path,
      manualIssue: { selections: { mode: 'work' } },
    } as OpenClawDispatchRecord;
    const task = await taskTurnContext({
      runtime: 'openclaw',
      workspace: '/fixture',
      manifest: { schemaVersion: 1, agent: { id: 'receiver' } },
      target: context.evidence.source,
      record,
      stage: 'assessment',
      resolveSkill: async () => context.assessment.skill,
    });
    const turn = openclawTurnContext(
      record,
      { agentId: 'receiver', sessionKey: 'issue', sessionId: 'incarnation', runId: 'assessment' },
      task,
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
        assert.fail('native context must let assessment start without a dispatch lookup');
      },
      minimumPages: 0,
      scenario: issuePickupScenario,
      prompt: `New issue assigned: clarify cleanup.\n\n${turn.appendContext}`,
      finalText: 'Should disposable issues close after evidence capture?',
    });
    assert.equal(sourceReads, 1);
  });
});
