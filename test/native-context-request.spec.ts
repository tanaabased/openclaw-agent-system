import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import codexContextRequest from '../agent/codex-context-request.ts';
import {
  nativeContextRequest,
  nativeContextResponse,
  assertModelWorkflowInput,
} from '../agent/native-context-request.ts';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';

describe('native current-task context inputs', () => {
  it('rejects bindings on scheduler reads and nested legacy delivery while retaining historical selection', async () => {
    for (const route of ['feedback', 'continuation'])
      assert.throws(
        () => assertModelWorkflowInput(route, { action: 'next', id: 'copied' }),
        /binding-override/,
      );
    for (const key of ['id', 'eventId', 'digest', 'agentId'])
      assert.throws(
        () =>
          assertModelWorkflowInput('continuation', {
            action: 'delivery',
            delivery: { action: 'publish', [key]: 'copied' },
          }),
        /binding-override/,
      );
    assert.doesNotThrow(() =>
      assertModelWorkflowInput('dispatch', { action: 'inspect', id: 'historical-resource' }),
    );
    const input = { action: 'delivery', delivery: { action: 'compose' } };
    assert.deepEqual(
      await codexContextRequest('private', 'continuation', input, 'thread', async () => ({
        receipt: 'owner',
        feedbackContextRequest: { eventId: 'verified-source' },
      })),
      { ...input, id: 'owner', delivery: { action: 'compose', eventId: 'verified-source' } },
    );
  });

  it('should bind an authorized handoff without a model-selected receipt or fingerprint', async () => {
    const input = { action: 'handoff' };
    assert.equal(Value.Check(dispatchModelParameters, input), true);
    assert.deepEqual(
      await codexContextRequest('private', 'dispatch', input, 'thread', async () => ({
        receipt: 'owner',
      })),
      { action: 'handoff', id: 'owner', apply: true },
    );
    for (const field of ['id', 'digest', 'apply']) {
      assert.equal(Value.Check(dispatchModelParameters, { ...input, [field]: 'owner' }), false);
      await assert.rejects(
        codexContextRequest('private', 'dispatch', { ...input, [field]: 'owner' }, 'thread'),
        /binding-override/,
      );
    }
  });

  it('should resolve result and readback ownership inside both native adapters', async () => {
    const requests = [
      { action: 'present' },
      { action: 'summary', operation: 'candidate', publicText: 'A concise proposal.' },
      {
        action: 'result',
        result: {
          version: 1,
          outcome: 'plan-ready',
          summary: 'Ready.',
          assessment: 'Small change.',
          fullAssessment: 'Change one line and verify the output.',
          plan: 'Change and verify.',
          evidence: [],
          progress: { completed: [], remaining: [] },
        },
      },
      {
        action: 'implementation-result',
        implementationResult: {
          outcome: 'done',
          summary: 'Changed.',
          fullResult: 'Changed the line and verified the output.',
        },
      },
    ];
    for (const request of requests) {
      assert.equal(Value.Check(dispatchModelParameters, request), true);
      assert.deepEqual(nativeContextRequest(request, { id: 'verified-owner' }), {
        ...request,
        id: 'verified-owner',
      });
      assert.deepEqual(
        await codexContextRequest('private', 'dispatch', request, 'thread', async () => ({
          receipt: 'verified-owner',
        })),
        { ...request, id: 'verified-owner' },
      );
      for (const field of ['id', 'eventId', 'digest', 'previousResultDigest']) {
        assert.equal(
          Value.Check(dispatchModelParameters, { ...request, [field]: 'verified-owner' }),
          false,
        );
        await assert.rejects(
          codexContextRequest(
            'private',
            'dispatch',
            { ...request, [field]: 'verified-owner' },
            'thread',
          ),
          /binding-override/,
        );
      }
    }
    for (const action of ['result', 'cancel', 'retry', 'retry-denied'])
      assert.deepEqual(
        await codexContextRequest('private', 'continuation', { action }, 'thread', async () => ({
          receipt: 'verified-owner',
        })),
        { action, id: 'verified-owner' },
      );
  });
  it('should bind publication to the verified current task and exact native feedback source', async () => {
    const input = { action: 'publish', title: 'A poem', body: 'Authored description' };
    const read = async () => ({ receipt: 'bound', feedbackContextRequest: { eventId: 'source' } });
    assert.deepEqual(
      await codexContextRequest('private', 'delivery', input, 'native-thread', read),
      { ...input, id: 'bound', eventId: 'source' },
    );
    for (const field of ['id', 'eventId', 'digest', 'threadId', 'workspace'])
      await assert.rejects(
        codexContextRequest(
          'private',
          'delivery',
          { ...input, [field]: 'bound' },
          'native-thread',
          read,
        ),
        /binding-override/,
      );
    const request = {
      action: 'delivery',
      operation: 'publish',
      title: input.title,
      body: input.body,
    };
    assert.equal(Value.Check(dispatchModelParameters, request), true);
    for (const field of ['id', 'eventId', 'digest', 'threadId', 'workspace'])
      assert.equal(Value.Check(dispatchModelParameters, { ...request, [field]: 'bound' }), false);
    await assert.rejects(
      codexContextRequest('private', 'delivery', input, 'native-thread', async () => undefined),
      /owner-unavailable/,
    );
  });
  it('should bind authored choices to the native owner without accepting overrides', () => {
    const request = {
      action: 'implementation-context',
      decision: { mode: 'work', reasons: ['authorized'] },
    };
    assert.equal(Value.Check(dispatchModelParameters, request), true);
    assert.deepEqual(nativeContextRequest(request, { id: 'bound' }), { ...request, id: 'bound' });
    assert.equal('id' in request, false);
    for (const id of ['bound', 'other']) {
      assert.equal(Value.Check(dispatchModelParameters, { ...request, id }), false);
      assert.throws(
        () => nativeContextRequest({ ...request, id }, { id: 'bound' }),
        /binding-override/,
      );
    }
    for (const owner of [
      undefined,
      { id: 'old', retired: true },
      { id: 'old', reset: true },
      { id: 'old', supersededBy: 'new' },
    ])
      assert.throws(() => nativeContextRequest(request, owner), /owner-unavailable/);
  });

  it('should resolve codex context through native caller evidence before workflow execution', async () => {
    const read = async (data: string, turn: { threadId: string }) => {
      assert.equal(data, 'private');
      assert.equal(turn.threadId, 'native-thread');
      return { receipt: 'bound' };
    };
    assert.deepEqual(
      await codexContextRequest(
        'private',
        'continuation',
        { action: 'context' },
        'native-thread',
        read,
      ),
      { action: 'context', id: 'bound' },
    );
    await assert.rejects(
      codexContextRequest(
        'private',
        'continuation',
        { action: 'context', id: 'bound' },
        'native-thread',
        async () => {
          throw new Error('must not read');
        },
      ),
      /binding-override/,
    );
    await assert.rejects(
      codexContextRequest(
        'private',
        'dispatch',
        { action: 'context' },
        'native-thread',
        async () => undefined,
      ),
      /owner-unavailable/,
    );
  });

  it('should remove ownership only from prepared current-task requests', () => {
    const response = {
      id: 'metadata',
      evidence: { id: 'provider-data' },
      continuationRequest: { action: 'context', id: 'bound' },
      contextMaterials: {
        fields: [
          {
            path: ['instructions'],
            request: { action: 'context', id: 'bound', material: { offset: 0 } },
          },
        ],
      },
    };
    const shown = nativeContextResponse(response, 'dispatch');
    assert.deepEqual(shown.continuationRequest, { action: 'context' });
    assert.deepEqual(shown.contextMaterials.fields[0]!.request, {
      action: 'context',
      material: { offset: 0 },
    });
    assert.equal(shown.evidence.id, 'provider-data');
    assert.equal(response.continuationRequest.id, 'bound');
  });
});
