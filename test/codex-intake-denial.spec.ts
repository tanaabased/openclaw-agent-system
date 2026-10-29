import assert from 'node:assert/strict';

import intakeDenial, { matchesDeniedPreparation } from '../agent/codex-intake-denial.ts';
import type { PreparationObservation } from '../agent/codex-dispatch-state.ts';

const anchor: PreparationObservation = {
  sourceThreadId: 'intake',
  turnId: 'original',
  intakeId: 'assignment',
  digest: 'routing-digest',
  at: 1000,
  afterItemId: 'routing',
  runtime: {
    nodeExecutable: '/node',
    entrypoint: '/plugin/runtime.js',
    pluginData: '/private/plugin',
  },
};
const receiptId = 'a'.repeat(64);
const otherReceiptId = 'b'.repeat(64);
const input = {
  action: 'prepare',
  id: receiptId,
  digest: 'routing-digest',
  title: 'repair contained behavior',
  assessment: { complexity: 'medium', reason: 'Contained change.' },
};
const command =
  "'/node' '/plugin/runtime.js' 'dispatch' 'prepare' '--plugin-data' '/private/plugin' <<'AGENT_SYSTEM_INPUT'\n" +
  JSON.stringify(input) +
  '\nAGENT_SYSTEM_INPUT';
const record = { id: receiptId, sourceThreadId: 'intake', preparationObservation: anchor };
const boundary = { id: 'routing', type: 'commandExecution', status: 'completed' };
const denied = {
  id: 'refusal',
  type: 'commandExecution',
  status: 'declined',
  command,
  aggregatedOutput: null,
  processId: null,
  exitCode: null,
};
function fixture(items: Record<string, unknown>[], partial = false) {
  return intakeDenial(async (method, params) => {
    assert.equal(params.threadId, 'intake');
    if (method === 'thread/turns/list')
      return { data: [{ id: 'original', status: 'interrupted' }], nextCursor: null };
    assert.equal(params.turnId, 'original');
    return {
      data: items.map((item) => ({ turnId: 'original', item })),
      nextCursor: partial ? 'again' : null,
    };
  }, record);
}

describe('agent/codex-intake-denial', () => {
  it('should retain an exact preparation denial beyond twenty metadata pages', async () => {
    let page = 0;
    const result = await intakeDenial(async (method, params) => {
      assert.equal(params.limit, undefined);
      if (method === 'thread/turns/list') {
        page++;
        return {
          data: [{ id: page === 23 ? 'original' : `later-${page}` }],
          nextCursor: page < 23 ? String(page) : null,
        };
      }
      return {
        data: (params.turnId === 'original' ? [boundary, denied] : []).map((item) => ({
          turnId: params.turnId,
          item,
        })),
        nextCursor: null,
      };
    }, record);
    assert.equal(result?.callId, 'refusal');
    assert.equal(page, 23);
  });
  it('should bind path launches without replacing historical executable evidence', async () => {
    const pathAnchor: PreparationObservation = {
      ...anchor,
      runtime: { ...anchor.runtime, nodeCommand: 'node', nodeVersion: '99.0.0' },
    };
    const pathCommand = command.replace("'/node'", "'node'");
    assert.equal(matchesDeniedPreparation(pathCommand, receiptId, pathAnchor), true);
    assert.equal(matchesDeniedPreparation(command, receiptId, pathAnchor), false);
    assert.equal(matchesDeniedPreparation(pathCommand, receiptId, anchor), false);
    assert.equal(
      matchesDeniedPreparation(
        pathCommand.replace('/private/plugin', '/other'),
        receiptId,
        pathAnchor,
      ),
      false,
    );
    assert.equal(
      matchesDeniedPreparation(pathCommand, receiptId, {
        ...pathAnchor,
        runtime: { ...pathAnchor.runtime, nodeExecutable: '/removed/node' },
      }),
      true,
    );
    const result = await intakeDenial(
      async (method) =>
        method === 'thread/turns/list'
          ? { data: [{ id: 'original' }], nextCursor: null }
          : {
              data: [boundary, { ...denied, command: pathCommand }].map((item) => ({
                turnId: 'original',
                item,
              })),
              nextCursor: null,
            },
      { ...record, preparationObservation: pathAnchor },
    );
    assert.equal(result?.callId, 'refusal');
    assert.equal(pathAnchor.runtime.nodeExecutable, '/node');
  });
  it('should bind only the fixed command and exact assignment routing evidence', () => {
    assert.equal(matchesDeniedPreparation(command, record.id, anchor), true);
    for (const changed of [
      command + '\nother',
      command.replace("prepare'", "next'"),
      command.replace('routing-digest', 'other'),
      command.replace('/private/plugin', '/other'),
      command.replace('/node', '/other'),
      command.replace(receiptId, otherReceiptId),
      command.replace('"action":"prepare"', '"action":"next"'),
      command.replace('"title":', '"unknown":true,"title":'),
      command.replace("<<'AGENT_SYSTEM_INPUT'", "| other <<'AGENT_SYSTEM_INPUT'"),
    ])
      assert.equal(matchesDeniedPreparation(changed, record.id, anchor), false, changed);
  });

  it('should retain a structured declined action after an interrupted turn without inventing a reason', async () => {
    assert.deepEqual(await fixture([boundary, denied]), {
      sourceThreadId: 'intake',
      turnId: 'original',
      callId: 'refusal',
      operation: 'prepare',
      automatic: false,
    });
    assert.equal(await fixture([boundary, { ...denied, status: 'completed' }]), undefined);
    assert.equal(
      await fixture([boundary, { id: 'prose', type: 'agentMessage', text: 'approval denied' }]),
      undefined,
    );
  });

  it('should preserve shared and ambiguous refusals rather than infer scope from an issue identifier', async () => {
    for (const items of [
      [boundary, { ...denied, command: command + '\nother' }],
      [boundary, denied, { ...denied, id: 'second' }],
      [boundary, denied, { id: 'file', type: 'fileChange', status: 'declined' }],
      [boundary, denied, { ...denied, id: 'executed', status: 'completed' }],
    ])
      await assert.rejects(fixture(items), /dispatch-denial-scope-unresolved/);
    await assert.rejects(
      fixture([boundary, { ...denied, status: 'inProgress' }]),
      /execution-unresolved/,
    );
    await assert.rejects(fixture([denied]), /history-unavailable/);
    await assert.rejects(fixture([boundary, denied], true), /native-response-invalid/);
  });

  it('should redact actual native review reasons and ignore arbitrary output', async () => {
    const message =
      'This action was rejected due to unacceptable risk.\nReason: repository excluded. token=secret ghp_notasecret123\nDo not bypass this rejection through a workaround or indirect execution.';
    const observed = await fixture([boundary, { ...denied, aggregatedOutput: message }]);
    assert.equal(observed!.automatic, true);
    assert.match(observed!.reason!, /repository excluded/);
    assert.doesNotMatch(observed!.reason!, /secret|ghp_/);
    assert.equal(
      (await fixture([
        boundary,
        { ...denied, aggregatedOutput: 'token=secret arbitrary command output' },
      ]))!.reason,
      undefined,
    );
  });

  it('should observe an exact denied creation and reject later uncertain attempts', async () => {
    const expected = { prompt: 'private prompt' };
    const refused = {
      id: 'create-refused',
      type: 'mcpToolCall',
      server: 'codex_app',
      tool: 'create_thread',
      arguments: expected,
      status: 'failed',
      result: null,
      error: { message: 'user rejected MCP tool call' },
    };
    let later: Record<string, unknown>[] = [];
    const native = async (method: string, params: Record<string, unknown>) => {
      if (method === 'thread/turns/list')
        return { data: [{ id: 'new' }, { id: 'original' }], nextCursor: null };
      return {
        data: (params.turnId === 'original' ? [boundary, refused] : later).map((item) => ({
          turnId: params.turnId,
          item,
        })),
        nextCursor: null,
      };
    };
    const prepared = {
      id: 'issue',
      sourceThreadId: 'intake',
      request: expected,
      preparationTurnId: 'original',
      creationAfterItemId: 'routing',
    };
    // the native request shape is irrelevant to matching; only exact retained equality matters here.
    const observe = () => intakeDenial(native, prepared as Parameters<typeof intakeDenial>[1]);
    assert.equal((await observe())!.operation, 'create');
    later = [{ ...refused, id: 'uncertain', status: 'inProgress', error: null }];
    await assert.rejects(observe(), /scope-unresolved/);
  });

  it('should allow the currently executing preparation but not an unresolved earlier execution', async () => {
    const executing = { ...denied, status: 'inProgress' };
    const native = async (method: string) =>
      method === 'thread/turns/list'
        ? { data: [{ id: 'original' }], nextCursor: null }
        : {
            data: [boundary, executing].map((item) => ({ turnId: 'original', item })),
            nextCursor: null,
          };
    assert.equal(await intakeDenial(native, record, true), undefined);
    await assert.rejects(intakeDenial(native, record), /execution-unresolved/);
    await assert.rejects(
      fixture([boundary, { ...denied, processId: 'process' }]),
      /execution-unresolved/,
    );
  });

  it('should reverify an already held receipt without making another issue denial its recovery gate', async () => {
    const other = {
      ...denied,
      id: 'other',
      command: command.replace(receiptId, otherReceiptId),
    };
    const native = async (method: string) => {
      assert.equal(method, 'thread/items/list');
      return {
        data: [boundary, denied, other].map((item) => ({ turnId: 'original', item })),
        nextCursor: null,
      };
    };
    const observed = await intakeDenial(native, record, false, 'refusal');
    assert.equal(observed!.callId, 'refusal');
    await assert.rejects(intakeDenial(native, record, false, 'other'), /denial-unverified/);
  });

  it('should exclude earlier item holds using the retained native boundary', async () => {
    assert.equal(await fixture([denied, boundary]), undefined);
  });
});
