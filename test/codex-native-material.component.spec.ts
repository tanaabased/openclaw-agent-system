import assert from 'node:assert/strict';
import renderNativeAssessment from '../agent/tasks/assessment/assessment-render.ts';

import assessmentMaterial from '../agent/tasks/assessment/assessment-material.ts';
import openclawTurnContext from '../agent/tasks/context/openclaw-turn-context.ts';
import taskTurnContext from '../agent/tasks/context/task-turn-context.ts';
import type { OpenClawDispatchRecord } from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import implementationMaterial, {
  implementationMaterialSize,
  type ImplementationMaterialRead,
} from '../agent/tasks/implementation/implementation-material.ts';
import { issuePickupScenario } from '../examples/openclaw-project-picker/model-fixture.ts';
import { hostedAssessmentContextFixture } from './assessment-material-fixture.ts';
import nativeMaterialFixture from './codex-native-material-fixture.ts';

describe('codex native material transport', () => {
  it('should deliver context above the former cutoff intact through codex tool output', async () => {
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
  it('should reconstruct paged material through codex without truncating the authored response', async () => {
    const privateResponse = 'Complete authored reply. '.repeat(1000);
    const request = { action: 'reply', operation: 'compose' };
    const context = { status: 'composition-ready', runtime: 'openclaw', privateResponse };
    await nativeMaterialFixture({
      request,
      run: (input) =>
        implementationMaterial(context, request, input.material as ImplementationMaterialRead),
      verify: (complete) => assert.equal(complete.privateResponse, privateResponse),
      minimumPages: 2,
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
  it('should deliver a complete fallback through codex tool output', async () => {
    const partial = {
      summary: 'Assess only.',
      reviewSummary: 'A concise review.',
    };
    const source = {
      ...partial,
      outcome: 'clarification-needed',
      reviewSummary: 'Choose the intended experience.',
      questions: Array.from(
        { length: 5 },
        (_, i) => `Question ${i}: ` + 'important detail '.repeat(700),
      ),
    };
    const request = {
      action: 'assessment',
      operation: 'render',
      target: 'https://github.com/owner/repo/issues/3',
      result: source,
    };
    await nativeMaterialFixture({
      request,
      run: (input) => renderNativeAssessment(input, 'openclaw'),
      minimumPages: 0,
      verify: (output) => {
        assert.equal(output.retained, false);
        assert.equal(output.status, 'presentation-unavailable');
        assert.equal(output.contextMaterials, undefined);
        assert.match(String(output.instructions), /every unanswered question/);
        assert.match(String(output.instructions), /ordinary Markdown/);
      },
    });
  });
});
