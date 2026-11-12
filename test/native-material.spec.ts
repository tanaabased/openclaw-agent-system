import assert from 'node:assert/strict';
import { Value } from 'typebox/value';
import { bindNativeMaterial, nativeMaterialResponse } from '../agent/native-material.ts';
import { codexMaterialReceipts, codexRuntimeReceipts } from '../agent/codex-native-material.ts';
import openClawNativeMaterial, {
  openClawMaterialReceipts,
} from '../agent/openclaw-native-material.ts';
import implementationMaterial, {
  type ImplementationMaterialRead,
} from '../agent/tasks/implementation/implementation-material.ts';
import { dispatchModelParameters } from '../tools/dispatch/tool-schema.ts';

async function* receipts(values: unknown[]) {
  yield* values;
}
const envelope = { action: 'context' };
const source = { runtime: 'codex', instructions: 'distinct instructions\n'.repeat(1000) };
const index = () =>
  nativeMaterialResponse(implementationMaterial(source, envelope), 'dispatch', envelope);

function pageRequest(output: ReturnType<typeof index>) {
  assert.ok('contextMaterials' in output && output.contextMaterials);
  return output.contextMaterials.fields[0]!.request;
}

describe('agent/native-material', () => {
  it('restores complete content using field and offset only, with native version custody', async () => {
    const history: unknown[] = [index()];
    let request: Record<string, unknown> | undefined = pageRequest(index());
    let text = '';
    while (request) {
      assert.equal(Value.Check(dispatchModelParameters, request), true);
      assert.equal('digest' in (request.material as object), false);
      const bound = await bindNativeMaterial('dispatch', request, receipts(history));
      const page: ReturnType<typeof implementationMaterial<typeof source>> = nativeMaterialResponse(
        implementationMaterial(source, envelope, bound.material as ImplementationMaterialRead),
        'dispatch',
        request,
      );
      assert.ok('materialPage' in page);
      assert.equal(page.materialPage.offset, text.length);
      text += page.materialPage.text;
      history.unshift(page);
      request = page.next;
    }
    assert.equal(JSON.parse(text), source.instructions);
  });

  it('rejects model versions, missing receipts, and receipts from another route or target', async () => {
    const request = pageRequest(index());
    const forged = {
      ...request,
      material: { ...(request.material as object), digest: 'a'.repeat(64) },
    };
    assert.equal(Value.Check(dispatchModelParameters, forged), false);
    await assert.rejects(
      bindNativeMaterial('dispatch', forged, receipts([index()])),
      /material-model-request-invalid/,
    );
    for (const [route, input] of [
      ['feedback', request],
      ['dispatch', { ...request, target: 'other' }],
    ] as const)
      await assert.rejects(
        bindNativeMaterial(route, input, receipts([index()])),
        /material-native-response-unavailable/,
      );
    await assert.rejects(
      bindNativeMaterial('dispatch', request, receipts([])),
      /material-native-response-unavailable/,
    );
  });

  it('rejects changed content and restarts after a refreshed root instead of mixing versions', async () => {
    const initial = index();
    const request = pageRequest(initial);
    const bound = await bindNativeMaterial('dispatch', request, receipts([initial]));
    assert.throws(
      () =>
        implementationMaterial(
          { ...source, instructions: source.instructions + 'changed' },
          envelope,
          bound.material as ImplementationMaterialRead,
        ),
      /material-stale/,
    );
    const first = nativeMaterialResponse(
      implementationMaterial(source, envelope, bound.material as ImplementationMaterialRead),
      'dispatch',
      request,
    );
    assert.ok('next' in first && first.next);
    await assert.rejects(
      bindNativeMaterial('dispatch', first.next, receipts([index(), first, initial])),
      /material-version-refreshed/,
    );
  });

  it('binds generated page requests when the root call has extra context options and render input fields', async () => {
    const authored = {
      action: 'assessment',
      operation: 'render',
      target: 'issue',
      result: { authored: true },
    };
    const output = nativeMaterialResponse(
      implementationMaterial(
        source,
        { action: 'assessment', operation: 'render', target: 'issue' },
        undefined,
        { inputFields: ['result'] },
      ),
      'dispatch',
      { ...authored, contextOnly: true },
    );
    const request = { ...pageRequest(output), result: authored.result };
    const bound = await bindNativeMaterial('dispatch', request, receipts([output]));
    assert.equal(typeof (bound.material as ImplementationMaterialRead).digest, 'string');
    await assert.rejects(
      bindNativeMaterial(
        'dispatch',
        { ...request, result: { authored: false } },
        receipts([output]),
      ),
      /material-native-response-unavailable/,
    );
  });

  it('normalizes the codex pickup command action without exposing a version input', async () => {
    const output = nativeMaterialResponse(
      implementationMaterial(source, { action: 'pickup' }),
      'intake',
      {},
    );
    const request = pageRequest(output);
    const input = { ...request };
    delete input.action;
    const bound = await bindNativeMaterial('intake', input, receipts([output]));
    assert.ok((bound.material as ImplementationMaterialRead).digest);
  });

  it('reads only successful exact-runtime codex receipts from the native caller, across turns', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const command = {
      type: 'commandExecution',
      status: 'completed',
      exitCode: 0,
      command: "node /runtime.js dispatch context --plugin-data /data <<'JSON'\n{}\nJSON",
      aggregatedOutput: JSON.stringify(index()),
    };
    const native = codexMaterialReceipts(
      async (method, params) => {
        calls.push([method, params]);
        if (method === 'thread/turns/list')
          return { data: [{ id: 'after-compact' }, { id: 'before-compact' }] };
        return {
          data:
            params.turnId === 'after-compact'
              ? [
                  { turnId: params.turnId, item: { ...command, exitCode: 1 } },
                  {
                    turnId: params.turnId,
                    item: {
                      ...command,
                      command: 'node /other.js dispatch context --plugin-data /data',
                    },
                  },
                  { turnId: params.turnId, item: { ...command, aggregatedOutput: 'truncated {' } },
                ]
              : [{ turnId: params.turnId, item: command }],
        };
      },
      'caller',
      { entrypoint: '/runtime.js', pluginData: '/data', node: '/node' },
    );
    const request = pageRequest(index());
    assert.ok((await bindNativeMaterial('dispatch', request, native)).material);
    assert.ok(calls.every(([, params]) => params.threadId === 'caller'));
  });

  it('uses native parsed commands for shell-wrapped receipts without selecting a host shell', async () => {
    const command = "node /runtime.js automations plan --plugin-data /data <<'JSON'\n{}\nJSON";
    const value = { status: 'requires-native-app-sync', digest: 'native-plan' };
    const item = {
      type: 'commandExecution',
      status: 'completed',
      exitCode: 0,
      command: `/custom/bin/zsh -lc "${command}"`,
      commandActions: [{ type: 'unknown', command }],
      aggregatedOutput: JSON.stringify(value),
    };
    const items = [
      item,
      { ...item, command: `/bin/bash -c "${command}"` },
      { ...item, command: `/usr/bin/sh -c "${command}"` },
      { ...item, commandActions: undefined },
      {
        ...item,
        commandActions: [{ type: 'unknown', command: command.replace('/data', '/other') }],
      },
      {
        ...item,
        commandActions: [{ type: 'unknown', command: command.replace('/runtime.js', '/other.js') }],
      },
      { ...item, commandActions: [{ type: 'unknown', command: `${command}\necho altered` }] },
      {
        ...item,
        commandActions: [...item.commandActions, { type: 'unknown', command: 'echo altered' }],
      },
      { ...item, exitCode: 1 },
    ];
    const observed = [];
    for await (const receipt of codexRuntimeReceipts(
      async (method) =>
        method === 'thread/turns/list'
          ? { data: [{ id: 'turn' }] }
          : { data: items.map((item) => ({ turnId: 'turn', item })) },
      'caller',
      { entrypoint: '/runtime.js', pluginData: '/data', node: '/node' },
    ))
      observed.push(receipt);
    assert.deepEqual(
      observed,
      Array.from({ length: 3 }, () => ({ route: 'automations', action: 'plan', value })),
    );
  });

  it('reads native tool-search receipts without accepting other tools, sources or failures', async () => {
    const output = nativeMaterialResponse(
      implementationMaterial(source, envelope),
      'agent_system_dispatch',
      envelope,
    );
    const wrapped = {
      tool: {
        id: 'openclaw:agent_system_dispatch',
        name: 'agent_system_dispatch',
        source: 'openclaw',
      },
      result: { content: [{ type: 'text', text: JSON.stringify(output) }] },
    };
    const message = (details: unknown) => ({
      role: 'toolResult',
      toolName: 'tool_call',
      details,
      __openclaw: {},
    });
    const native = openClawMaterialReceipts(
      async () => ({
        sessionId: 'session',
        messages: [
          message(wrapped),
          { ...message(undefined), content: [{ type: 'text', text: JSON.stringify(wrapped) }] },
          message({ ...wrapped, tool: { ...wrapped.tool, name: 'other' } }),
          message({ ...wrapped, tool: { ...wrapped.tool, source: 'mcp' } }),
          message({ ...wrapped, result: { ...wrapped.result, isError: true } }),
          { ...message(wrapped), isError: true },
          { ...message(wrapped), role: 'user' },
        ],
      }),
      { sessionKey: 'agent:bound', sessionId: 'session' },
      'agent_system_dispatch',
    );
    const observed = [];
    for await (const receipt of native) observed.push(receipt);
    assert.deepEqual(observed, [output, output]);
    assert.ok(
      (await bindNativeMaterial('agent_system_dispatch', pageRequest(output), receipts(observed)))
        .material,
    );
  });

  it('recovers context pages from the no-argument tool receipt without widening other operations', async () => {
    const root = nativeMaterialResponse(
      implementationMaterial(source, envelope),
      'agent_system_dispatch',
      envelope,
    );
    const read = async () => ({
      sessionId: 'session',
      messages: [
        { role: 'toolResult', toolName: 'agent_system_context', details: root, __openclaw: {} },
      ],
    });
    const request = pageRequest(root);
    const bound = await openClawNativeMaterial(
      read,
      { sessionKey: 'chat', sessionId: 'session' },
      'agent_system_dispatch',
      request,
    );
    assert.equal(typeof (bound.material as ImplementationMaterialRead).digest, 'string');
    await assert.rejects(
      openClawNativeMaterial(
        read,
        { sessionKey: 'chat', sessionId: 'session' },
        'agent_system_dispatch',
        { ...request, action: 'result' },
      ),
      /material-native-response-unavailable/,
    );
  });

  it('reads only the bound openclaw tool responses and recovers native truncated output', async () => {
    const output = nativeMaterialResponse(
      implementationMaterial(source, envelope),
      'agent_system_dispatch',
      envelope,
    );
    const request = pageRequest(output);
    const native = openClawMaterialReceipts(
      async (method, params) => {
        assert.equal(params.sessionKey, 'agent:bound');
        if (method === 'chat.message.get')
          return {
            ok: true,
            message: {
              role: 'toolResult',
              toolName: 'agent_system_dispatch',
              details: output,
              __openclaw: { id: 'receipt' },
            },
          };
        return {
          sessionId: 'session',
          messages: [
            {
              role: 'toolResult',
              toolName: 'agent_system_dispatch',
              __openclaw: { id: 'receipt', truncated: true },
            },
            { role: 'user', toolName: 'agent_system_dispatch', details: output },
            { role: 'toolResult', toolName: 'other', details: output },
            {
              role: 'toolResult',
              toolName: 'agent_system_dispatch',
              isError: true,
              details: output,
            },
          ],
        };
      },
      { sessionKey: 'agent:bound', sessionId: 'session' },
      'agent_system_dispatch',
    );
    assert.ok((await bindNativeMaterial('agent_system_dispatch', request, native)).material);
  });
});
