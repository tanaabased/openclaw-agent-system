import assert from 'node:assert/strict';
import { Value } from 'typebox/value';

import codexContextRequest from '../agent/codex-context-request.ts';
import { nativeContextRequest, nativeContextResponse } from '../agent/native-context-request.ts';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';

describe('native current-task context inputs', () => {
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
