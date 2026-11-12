import assert from 'node:assert/strict';

import { type ChatCompletionRequest, type FixtureResponse } from '@copilotkit/aimock';

import { pickupResponse } from '../examples/openclaw-project-picker/model-fixture.ts';
import taskTurnContext from '../agent/tasks/context/task-turn-context.ts';
import openclawTurnContext from '../agent/tasks/context/openclaw-turn-context.ts';
import type { OpenClawDispatchRecord } from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';

function request(prompt: string, results: Array<[string, unknown]> = []): ChatCompletionRequest {
  return {
    model: 'gpt-5.5',
    messages: [
      { role: 'user', content: prompt },
      {
        role: 'user',
        content: 'OpenClaw runtime context:\nCurrent runtime facts.\nEnd OpenClaw runtime context.',
      },
      ...results.map(([id, value]) => ({
        role: 'tool' as const,
        tool_call_id: `call_pickup_${id}-0`,
        content: JSON.stringify(value),
      })),
    ],
  };
}
function argumentsOf(response: FixtureResponse | undefined) {
  assert.ok(response && 'toolCalls' in response && response.toolCalls?.length === 1);
  return JSON.parse(response.toolCalls[0]!.arguments);
}

const prompt = 'Run the activated issue pickup once.';

describe('examples/openclaw-project-picker model fixture', () => {
  it('should read candidate links before selecting through native snapshot identifiers', () => {
    const candidates = [
      { nodeId: 'larger-issue', url: 'https://github.com/owner/repo/issues/1' },
      { nodeId: 'small-issue', url: 'https://github.com/owner/repo/issues/2' },
    ];
    const input = request(prompt, [
      [
        'scan-0',
        {
          status: 'selection-required',
          id: 'native-scan',
          digest: 'native-digest',
          guidance: 'Prefer the bounded cleanup clarification.',
          repositoryGuidance: {
            'tanaabased/big-test-bucket': { content: 'prefer fixture cleanup questions' },
          },
          candidates,
        },
      ],
    ]);
    for (const [index, candidate] of candidates.entries()) {
      const response = pickupResponse(input);
      assert.ok(response && 'toolCalls' in response);
      assert.equal(response.toolCalls![0]!.name, 'agent_system_github');
      assert.deepEqual(argumentsOf(response), {
        argv: ['issue', 'view', candidate.url, '--json', 'body,comments'],
      });
      input.messages.push({
        role: 'tool',
        tool_call_id: response.toolCalls![0]!.id,
        content: JSON.stringify({
          exitCode: 0,
          truncated: false,
          stdout: JSON.stringify({
            body: index === 1 ? 'pickup-cleanup-clarification' : 'Redesign everything.',
            comments: [],
          }),
        }),
      });
    }
    assert.deepEqual(argumentsOf(pickupResponse(input)), {
      action: 'pickup',
      selection: {
        issueNodeId: 'small-issue',
        shortlist: ['larger-issue', 'small-issue'],
        rationale: 'The bounded cleanup clarification is smaller than the redesign.',
      },
    });
  });

  it('should preserve terminal cards and refuse to conceal failed or uncertain assignments', () => {
    for (const status of ['empty', 'assigned', 'allowance-reached']) {
      const response =
        status === 'assigned'
          ? '📥 assigned an issue · 2 eligible\nGuidance source: inline\n' +
            'bounded cleanup clarification\n' +
            'long diagnostic context '.repeat(120) +
            'prefer fixture cleanup'
          : `📥 ${status} native card`;
      assert.deepEqual(pickupResponse(request(prompt, [['scan-0', { status, response }]])), {
        content: response,
      });
    }
    assert.throws(
      () =>
        pickupResponse(
          request(prompt, [
            ['scan-0', { status: 'assigned', response: '📥 assigned an issue · 2 eligible' }],
          ]),
        ),
      /Guidance source/u,
    );
    for (const status of ['failed', 'attempted', 'blocked']) {
      assert.throws(() =>
        pickupResponse(request(prompt, [['scan-0', { status, code: 'native-failure' }]])),
      );
    }
  });

  it('should keep prior scan results out of the next native turn', () => {
    const input = request(prompt, [['scan-0', { status: 'empty', response: '📥 empty' }]]);
    input.messages.push(...request(prompt).messages);
    assert.deepEqual(argumentsOf(pickupResponse(input)), { action: 'pickup' });
  });

  it('should retry only recognized contention with the same operation and a bounded budget', () => {
    const input = request(prompt, [
      ['scan-0', { status: 'busy', code: 'private-state-file-lock-busy' }],
    ]);
    const response = pickupResponse(input);
    assert.deepEqual(argumentsOf(response), { action: 'pickup' });
    assert.ok(response && 'toolCalls' in response);
    assert.equal(response.toolCalls![0]!.id, 'call_pickup_scan-0-1');
    for (let attempt = 1; attempt <= 3; attempt++)
      input.messages.push({
        role: 'tool',
        tool_call_id: `call_pickup_scan-0-${attempt}`,
        content: JSON.stringify({ status: 'busy', code: 'private-state-file-lock-busy' }),
      });
    assert.throws(() => pickupResponse(input), /contention exhausted/u);
  });

  it('should require ordinary intake to supply work mode before asking a native question', async () => {
    const id = 'a'.repeat(64);
    const context = {
      status: 'verified',
      mode: 'work',
      project: { path: '/fixture/issue' },
      evidence: { source: 'https://github.com/owner/repo/issues/2' },
    };
    const record = {
      id,
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
      resolveSkill: async () => ({
        name: 'assessment',
        path: '/fixture/SKILL.md',
        scope: 'test',
        digest: 'b'.repeat(64),
      }),
    });
    const privateContext = openclawTurnContext(
      record,
      { agentId: 'receiver', sessionKey: 'issue', sessionId: 'incarnation', runId: 'assessment' },
      task,
    )!;
    const input = request('New issue assigned: clarify cleanup.');
    input.messages.push({ role: 'user', content: privateContext.appendContext });
    const read = pickupResponse(input);
    assert.ok(read && 'toolCalls' in read);
    assert.equal(read.toolCalls![0]!.name, 'agent_system_github');
    input.messages.push({
      role: 'tool',
      tool_call_id: read.toolCalls![0]!.id,
      content: JSON.stringify({
        exitCode: 0,
        truncated: false,
        stdout: JSON.stringify({ title: 'Cleanup', body: 'Clarify cleanup.', comments: [] }),
      }),
    });
    assert.deepEqual(pickupResponse(input), {
      content: 'Should disposable issues close after evidence capture?',
    });
    const wrongMode = structuredClone(input);
    const native = wrongMode.messages.find(
      (message) =>
        typeof message.content === 'string' &&
        message.content.includes('model-only current-turn facts'),
    )!;
    native.content = String(native.content).replace('"mode":"work"', '"mode":"plan"');
    assert.throws(() => pickupResponse(wrongMode), /override ordinary plan mode/u);
  });
});
