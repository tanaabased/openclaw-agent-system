import assert from 'node:assert/strict';

import codexContinuationNative from '../agent/codex-continuation-native.ts';
import type { CodexContinuationState } from '../agent/codex-continuation-state.ts';

// constructed protocol cases; the authorized desktop pilot owns live native evidence.
describe('agent/codex-continuation-native', () => {
  const attempt: NonNullable<CodexContinuationState['attempt']> = {
    id: 'a'.repeat(64),
    sourceTurnId: 'scan',
    beforeTurnId: 'assessment',
    request: {
      threadId: 'issue',
      prompt: 'Continue this issue.',
      model: 'model',
      thinking: 'high',
    },
  };
  it('should verify exact native operator input instead of an invented assessment or delegated receipt', async () => {
    const direct = {
      ...attempt,
      origin: 'input' as const,
      sourceThreadId: 'issue',
      sourceTurnId: 'operator-turn',
      beforeTurnId: 'operator-turn',
      turnId: 'operator-turn',
      inputId: 'operator-input',
    };
    let items: Array<Record<string, unknown>> = [
      {
        id: 'operator-input',
        type: 'userMessage',
        content: [{ type: 'text', text: 'Implement the plan.' }],
      },
    ];
    const verify = codexContinuationNative(async () => ({
      data: items.map((item) => ({ turnId: 'operator-turn', item })),
    }));
    assert.equal((await verify('intake', direct)).status, 'verified');
    items[0]!.type = 'agentMessage';
    await assert.rejects(verify('intake', direct), /continuation-input-unverified/);
    items[0]!.type = 'userMessage';
    items.push({
      type: 'functionCallOutput',
      namespace: 'codex_app',
      name: 'send_message_to_thread',
      output: 'quoted operator direction',
    });
    await assert.rejects(verify('intake', direct), /continuation-input-unverified/);
    items = [{ id: 'wrong-input', type: 'userMessage' }];
    await assert.rejects(verify('intake', direct), /continuation-input-unverified/);
    items = [
      { id: 'operator-input', type: 'userMessage' },
      { type: 'commandExecution', status: 'declined' },
    ];
    assert.equal((await verify('intake', direct)).status, 'blocked');
  });
  function fixture(
    options: {
      call?: boolean;
      status?: string;
      duplicate?: boolean;
      duplicateSend?: boolean;
      followUp?: boolean;
      sameTurn?: boolean;
      prompt?: string;
      sourceTurn?: string;
      forged?: boolean;
      turnStatus?: string;
      completedAt?: number | null;
      items?: Array<Record<string, unknown>>;
      arguments?: Record<string, unknown>;
      error?: { message: string };
      result?: unknown;
    } = {},
  ) {
    const call = {
      id: 'native-send',
      type: options.forged ? 'agentMessage' : 'mcpToolCall',
      server: 'codex_app',
      tool: 'send_message_to_thread',
      arguments: options.arguments ?? attempt.request,
      status: options.status ?? 'completed',
      error: options.error,
      result: options.result,
    };
    const source = [
      {
        id: options.sourceTurn ?? 'scan',
        status: 'completed',
        items: options.call === false ? [] : options.duplicateSend ? [call, call] : [call],
      },
    ];
    const implementation = {
      id: 'implementation',
      status: options.turnStatus ?? 'inProgress',
      completedAt: options.completedAt ?? null,
      items: [
        {
          type: 'userMessage',
          content: [{ type: 'text', text: options.prompt ?? attempt.request.prompt }],
        },
        ...(options.items ?? []),
      ],
    };
    const steered = {
      ...implementation,
      id: 'assessment',
      items: [
        {
          type: 'functionCallOutput',
          namespace: 'codex_app',
          name: 'send_message_to_thread',
          output:
            '<codex_delegation>\n  <source_thread_id>source</source_thread_id>\n  <input>' +
            (options.prompt ?? attempt.request.prompt) +
            '</input>\n</codex_delegation>',
        },
      ],
    };
    const target = [
      ...(options.sameTurn
        ? [steered]
        : [{ id: 'assessment', status: 'completed', items: [] }, implementation]),
      ...(options.duplicate ? [{ ...implementation, id: 'duplicate' }] : []),
      ...(options.followUp
        ? [{ id: 'followup', status: 'completed', completedAt: 2, items: [] }]
        : []),
    ];
    return codexContinuationNative(async (method, params) => {
      if (params.threadId === 'source') {
        assert.equal(method, 'thread/items/list');
        assert.equal(params.turnId, attempt.sourceTurnId);
      }
      const turns = params.threadId === 'source' ? source : target;
      return {
        data:
          method === 'thread/turns/list'
            ? turns
            : turns.flatMap((turn) => turn.items.map((item) => ({ turnId: turn.id, item }))),
        nextCursor: null,
      };
    });
  }
  it('should verify only the recorded source turn and its exact native target', async () => {
    assert.deepEqual(await fixture()('source', attempt), {
      status: 'verified',
      turnId: 'implementation',
      ended: false,
    });
  });

  it('should verify a direct assessment origin without looking for a coordinator send', async () => {
    const direct = {
      ...attempt,
      origin: 'assessment' as const,
      sourceThreadId: attempt.request.threadId,
      sourceTurnId: 'assessment',
      turnId: 'assessment',
    };
    const verify = fixture({ call: false });
    assert.deepEqual(await verify('source', direct), {
      status: 'verified',
      turnId: 'assessment',
      ended: false,
    });
    await assert.rejects(
      verify('source', { ...direct, sourceThreadId: 'other' }),
      /continuation-assessment-origin-invalid/,
    );
    await assert.rejects(
      verify('source', { ...direct, turnId: 'missing', sourceTurnId: 'missing' }),
      /continuation-history-incomplete/,
    );
  });

  it('should retain native denial and completion evidence for a direct origin', async () => {
    const direct = {
      ...attempt,
      origin: 'assessment' as const,
      sourceThreadId: attempt.request.threadId,
      sourceTurnId: 'implementation',
      turnId: 'implementation',
    };
    const denied = await fixture({
      call: false,
      items: [{ type: 'commandExecution', status: 'declined' }],
    })('source', direct);
    assert.equal(denied.status, 'blocked');
    assert.equal('code' in denied && denied.code, 'continuation-native-approval-denied');
    assert.deepEqual(
      await fixture({ call: false, turnStatus: 'completed', completedAt: 2 })('source', direct),
      { status: 'verified', turnId: 'implementation', ended: true },
    );
  });
  it('should reconcile native steering within the observed turn without resending', async () => {
    assert.deepEqual(await fixture({ sameTurn: true })('source', attempt), {
      status: 'verified',
      turnId: 'assessment',
      ended: false,
    });
    assert.deepEqual(
      await fixture({ sameTurn: true, turnStatus: 'completed', completedAt: 1 })('source', attempt),
      {
        status: 'verified',
        turnId: 'assessment',
        ended: true,
      },
    );
    assert.deepEqual(await fixture({ sameTurn: true, prompt: 'different' })('source', attempt), {
      status: 'uncertain',
    });
  });
  it('should reconcile a send from its recorded owner after the coordinator is replaced', async () => {
    assert.equal(
      (await fixture()('old-coordinator', { ...attempt, sourceThreadId: 'source' })).status,
      'verified',
    );
    assert.equal(
      (
        await fixture({ sameTurn: true })('old-coordinator', {
          ...attempt,
          sourceThreadId: 'source',
        })
      ).status,
      'verified',
    );
    // Older attempts have no source field and keep using the original owner.
    assert.equal((await fixture()('source', attempt)).status, 'verified');
  });

  it('should accept an explicit local host without relaxing the prepared request', async () => {
    assert.equal(
      (await fixture({ arguments: { ...attempt.request, hostId: 'local' } })('source', attempt))
        .status,
      'verified',
    );
    for (const changed of [
      { hostId: 'remote' },
      { hostId: 'local', threadId: 'other' },
      { hostId: 'local', prompt: 'Different instructions.' },
      { hostId: 'local', model: 'other' },
      { hostId: 'local', thinking: 'low' },
      { hostId: 'local', unknown: true },
    ])
      assert.deepEqual(
        await fixture({ arguments: { ...attempt.request, ...changed } })('source', attempt),
        changed.threadId === 'other' || changed.prompt
          ? { status: 'uncertain' }
          : { status: 'blocked', code: 'continuation-send-mismatch' },
      );
  });

  it('should verify settings-inheriting sends while rejecting injected overrides', async () => {
    const inherited = {
      ...attempt,
      request: { threadId: 'issue', prompt: attempt.request.prompt },
    };
    assert.equal(
      (await fixture({ arguments: inherited.request })('source', inherited)).status,
      'verified',
    );
    for (const override of [{ model: 'other' }, { thinking: 'low' }])
      assert.deepEqual(
        await fixture({ arguments: { ...inherited.request, ...override } })('source', inherited),
        { status: 'blocked', code: 'continuation-send-mismatch' },
      );
  });

  it('should retain a completed altered prompt as mismatch evidence without verifying it', async () => {
    const altered = { ...attempt.request, prompt: 'Continue this issue' };
    const inspect = fixture({
      arguments: altered,
      prompt: altered.prompt,
      turnStatus: 'completed',
      completedAt: 1,
      followUp: true,
    });
    const result = await inspect('source', attempt);
    assert.equal(result.status, 'mismatch');
    assert.equal('turnId' in result && result.turnId, 'implementation');
    assert.equal('latestTurnId' in result && result.latestTurnId, 'followup');
    assert.equal('callId' in result && result.callId, 'native-send');
    assert.equal('ended' in result && result.ended, true);
    const denied = await fixture({
      arguments: altered,
      prompt: altered.prompt,
      items: [{ type: 'commandExecution', status: 'declined' }],
    })('source', attempt);
    assert.equal(denied.status, 'blocked');
    assert.equal('code' in denied && denied.code, 'continuation-native-approval-denied');
  });
  it('should require a native end timestamp before classifying a terminal history status as ended', async () => {
    for (const turnStatus of ['completed', 'failed', 'interrupted']) {
      for (const completedAt of [undefined, null, 0, NaN])
        assert.deepEqual(await fixture({ turnStatus, completedAt })('source', attempt), {
          status: 'verified',
          turnId: 'implementation',
          ended: false,
        });
      assert.deepEqual(await fixture({ turnStatus, completedAt: 1791919616 })('source', attempt), {
        status: 'verified',
        turnId: 'implementation',
        ended: true,
      });
    }
    assert.deepEqual(
      await fixture({ turnStatus: 'inProgress', completedAt: 1791919616 })('source', attempt),
      {
        status: 'verified',
        turnId: 'implementation',
        ended: false,
      },
    );
  });
  it('should retain uncertainty when a send or target response is missing', async () => {
    for (const options of [
      { call: false },
      { prompt: 'Something else.' },
      { status: 'inProgress' },
    ])
      assert.deepEqual(await fixture(options)('source', attempt), { status: 'uncertain' });
  });
  it('should reject copied prose and duplicate or unrelated turns', async () => {
    await assert.rejects(fixture({ duplicateSend: true })('source', attempt), /send-duplicated/);
    assert.deepEqual(await fixture({ forged: true })('source', attempt), { status: 'uncertain' });
    await assert.rejects(fixture({ duplicate: true })('source', attempt), /turn-ambiguous/);
    await assert.rejects(
      fixture({ sourceTurn: 'old-scan' })('source', attempt),
      /source-unavailable/,
    );
  });
  it('should stop after native denial instead of treating failure as an unsubmitted request', async () => {
    assert.deepEqual(await fixture({ status: 'failed' })('source', attempt), {
      status: 'blocked',
      code: 'continuation-native-send-failed',
    });
  });

  it('should expose reapproval evidence only for an exact native approval rejection', async () => {
    for (const message of [
      'user rejected MCP tool call',
      'This action was rejected due to unacceptable risk.\nReason: missing authorization.\nDo not bypass this rejection through a workaround or indirect execution.',
    ]) {
      const receipt = await fixture({ status: 'failed', error: { message } })('source', attempt);
      assert.equal(receipt.status, 'blocked');
      assert.equal('rejection' in receipt && receipt.rejection?.callId, 'native-send');
      assert.equal('rejection' in receipt && receipt.rejection?.reason, message);
    }
    for (const options of [
      { error: { message: 'request timed out' } },
      { error: { message: 'user rejected MCP tool call' }, result: {} },
      {
        error: { message: 'user rejected MCP tool call' },
        arguments: { ...attempt.request, prompt: 'altered' },
      },
    ]) {
      const receipt = await fixture({ status: 'failed', ...options })('source', attempt);
      assert.equal('rejection' in receipt && Boolean(receipt.rejection), false);
    }
    await assert.rejects(
      fixture({ status: 'failed', duplicateSend: true })('source', attempt),
      /send-duplicated/,
    );
  });

  it('should stop on approval denials in the verified implementation turn', async () => {
    for (const item of [
      { type: 'commandExecution', status: 'declined' },
      { type: 'fileChange', status: 'declined' },
      { type: 'mcpToolCall', status: 'failed', error: { message: 'user rejected MCP tool call' } },
      {
        type: 'mcpToolCall',
        status: 'failed',
        error: {
          message:
            'This action was rejected due to unacceptable risk.\nReason: publication denied.\nDo not bypass this rejection through a workaround or indirect execution.',
        },
      },
    ])
      assert.deepEqual(
        await fixture({ items: [item], turnStatus: 'completed', completedAt: 1, followUp: true })(
          'source',
          attempt,
        ),
        {
          status: 'blocked',
          code: 'continuation-native-approval-denied',
          turnId: 'implementation',
          ended: true,
        },
      );
  });

  it('should not interpret ordinary tool failures or copied prose as approval denials', async () => {
    assert.equal(
      (
        await fixture({
          items: [
            { type: 'commandExecution', status: 'failed', exitCode: 1 },
            { type: 'mcpToolCall', status: 'failed', error: { message: 'request timed out' } },
            { type: 'agentMessage', status: 'declined', text: 'user rejected MCP tool call' },
          ],
        })('source', attempt)
      ).status,
      'verified',
    );
  });
});
