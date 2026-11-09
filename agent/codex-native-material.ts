import { realpath } from 'node:fs/promises';
import { nativeObject } from './automation-gateway.ts';
import { dispatchHistoryPages, nativeHistoryPages } from './codex-dispatch-history.ts';
import literalArguments from './literal-command-arguments.ts';
import { assertModelMaterial, bindNativeMaterial } from './native-material.ts';
import { connectCodexCaller, type CodexThreadRequest } from './codex-thread-client.ts';

export async function* codexRuntimeReceipts(
  request: CodexThreadRequest,
  caller: string,
  runtime: { entrypoint: string; pluginData: string; node: string },
) {
  for await (const turns of nativeHistoryPages(request, 'thread/turns/list', {
    threadId: caller,
    sortDirection: 'desc',
    itemsView: 'notLoaded',
  })) {
    for (const turn of turns) {
      if (typeof turn.id !== 'string') throw new Error('material-native-history-invalid');
      const items = await dispatchHistoryPages(request, 'thread/items/list', {
        threadId: caller,
        turnId: turn.id,
        sortDirection: 'desc',
      });
      for (const entry of items) {
        const item = entry.item;
        if (entry.turnId !== turn.id || !nativeObject(item))
          throw new Error('material-native-history-invalid');
        if (
          item.type !== 'commandExecution' ||
          item.status !== 'completed' ||
          item.exitCode !== 0 ||
          typeof item.command !== 'string' ||
          typeof item.aggregatedOutput !== 'string'
        )
          continue;
        const argv = literalArguments(item.command);
        if (
          !argv ||
          (argv[0] !== 'node' && argv[0] !== runtime.node) ||
          argv[1] !== runtime.entrypoint
        )
          continue;
        const data = argv.indexOf('--plugin-data');
        if (data < 3 || argv[data + 1] !== runtime.pluginData || data + 2 !== argv.length) continue;
        try {
          const result: unknown = JSON.parse(item.aggregatedOutput);
          if (nativeObject(result))
            yield { route: argv[2]!, action: data > 3 ? argv[3] : undefined, value: result };
        } catch {
          /* Truncated or mixed output is not a version receipt. */
        }
      }
    }
  }
}

export async function* codexMaterialReceipts(...args: Parameters<typeof codexRuntimeReceipts>) {
  for await (const receipt of codexRuntimeReceipts(...args)) yield receipt.value;
}

export async function codexNativeRuntimeResult(
  pluginData: string,
  route: string,
  actions: readonly string[],
  status?: string,
) {
  const caller = process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('native-receipt-caller-required');
  const connection = await connectCodexCaller();
  try {
    for await (const receipt of codexRuntimeReceipts(connection.request, caller, {
      entrypoint: await realpath(process.argv[1]!),
      pluginData,
      node: process.execPath,
    }))
      if (
        receipt.route === route &&
        receipt.action &&
        actions.includes(receipt.action) &&
        (!status || receipt.value.status === status)
      )
        return receipt.value;
    throw new Error('native-receipt-unavailable: repeat the read-only preparation in this chat');
  } finally {
    await connection.close();
  }
}

export default async function codexNativeMaterial(
  pluginData: string,
  route: string,
  input: Record<string, unknown>,
) {
  assertModelMaterial(input);
  if (!input.material) return input;
  const caller = process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('material-native-caller-required');
  const connection = await connectCodexCaller();
  try {
    return await bindNativeMaterial(
      route,
      input,
      codexMaterialReceipts(connection.request, caller, {
        entrypoint: await realpath(process.argv[1]!),
        pluginData,
        node: process.execPath,
      }),
    );
  } finally {
    await connection.close();
  }
}
