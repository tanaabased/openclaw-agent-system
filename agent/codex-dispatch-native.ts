import { realpath } from 'node:fs/promises';

import { nativeObject } from './automation-gateway.ts';
import { automationHash } from './automation-hash.ts';
import { CodexThreadRpcError, type CodexThreadRequest } from './codex-thread-client.ts';

export interface DispatchNativeThread {
  id: string;
  cwd: string;
  name?: string;
  model?: string;
  effort?: string;
  status: string;
  turnStatus?: string;
  turnId?: string;
}

function escaped(value: string) {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** only native creation items establish provenance; quoted/user-authored markers never do. */
export function matchesDispatchCreation(
  thread: Record<string, unknown>,
  sourceThreadId: string,
  prompt: string,
): boolean {
  if (!Array.isArray(thread.turns)) return false;
  const turn = thread.turns[0];
  if (!nativeObject(turn) || !Array.isArray(turn.items)) return false;
  const expected =
    '<codex_delegation>\n  <source_thread_id>' +
    escaped(sourceThreadId) +
    '</source_thread_id>\n  <input>' +
    escaped(prompt) +
    '</input>\n</codex_delegation>';
  return turn.items.some(
    (item) =>
      nativeObject(item) &&
      item.type === 'functionCallOutput' &&
      item.name === 'create_thread' &&
      item.namespace === 'codex_app' &&
      item.output === expected,
  );
}

/** read supported native history; no thread creation, resumption, or filesystem history parsing. */
export function codexDispatchNative(request: CodexThreadRequest) {
  async function read(id: string) {
    try {
      const result = await request('thread/read', { threadId: id, includeTurns: true });
      if (!nativeObject(result.thread) || result.thread.id !== id)
        throw new Error('dispatch-native-response-invalid');
      return result.thread;
    } catch (error) {
      if (
        error instanceof CodexThreadRpcError &&
        error.code === -32600 &&
        error.message === 'no rollout found for thread id ' + id
      )
        return undefined;
      throw error;
    }
  }
  async function verify(
    thread: Record<string, unknown>,
    input: { sourceThreadId: string; prompt: string },
  ): Promise<DispatchNativeThread> {
    if (
      !matchesDispatchCreation(thread, input.sourceThreadId, input.prompt) ||
      typeof thread.id !== 'string' ||
      typeof thread.cwd !== 'string' ||
      !nativeObject(thread.status) ||
      typeof thread.status.type !== 'string' ||
      thread.ephemeral === true ||
      thread.canAcceptDirectInput === false ||
      (typeof thread.path === 'string' && thread.path.split(/[\\/]/u).includes('archived_sessions'))
    )
      throw new Error('dispatch-native-readback-diverged');
    const latestTurn = Array.isArray(thread.turns) ? thread.turns.at(-1) : undefined;
    return {
      id: thread.id,
      cwd: await realpath(thread.cwd),
      status: thread.status.type,
      ...(nativeObject(latestTurn) && typeof latestTurn.id === 'string'
        ? { turnId: latestTurn.id }
        : {}),
      ...(nativeObject(latestTurn) && typeof latestTurn.status === 'string'
        ? { turnStatus: latestTurn.status }
        : {}),
      ...(typeof thread.name === 'string' ? { name: thread.name } : {}),
      ...(typeof thread.model === 'string' ? { model: thread.model } : {}),
      ...(typeof thread.reasoningEffort === 'string' ? { effort: thread.reasoningEffort } : {}),
    };
  }
  return {
    async deniedCreation(
      sourceThreadId: string,
      expected: Record<string, unknown>,
      approvedCallId?: string,
    ) {
      const source = await read(sourceThreadId);
      if (
        !source ||
        !nativeObject(source.status) ||
        !['idle', 'notLoaded'].includes(String(source.status.type)) ||
        !Array.isArray(source.turns)
      )
        throw new Error('dispatch-denial-unverified');
      const matches = source.turns.flatMap((turn) =>
        nativeObject(turn) && Array.isArray(turn.items)
          ? turn.items.flatMap((item) =>
              nativeObject(item) &&
              item.type === 'mcpToolCall' &&
              item.server === 'codex_app' &&
              item.tool === 'create_thread' &&
              automationHash(item.arguments) === automationHash(expected)
                ? [{ turn, item }]
                : [],
            )
          : [],
      );
      const match = matches[0];
      if (
        matches.length !== 1 ||
        !match ||
        !['completed', 'interrupted', 'failed'].includes(String(match.turn.status)) ||
        typeof match.turn.id !== 'string' ||
        typeof match.item.id !== 'string' ||
        match.item.status !== 'failed' ||
        match.item.result != null ||
        !nativeObject(match.item.error)
      )
        throw new Error('dispatch-denial-unverified');
      const message = match.item.error.message;
      const automatic =
        typeof message === 'string' &&
        message.startsWith('This action was rejected due to unacceptable risk.\nReason: ') &&
        message.includes(
          'Do not bypass this rejection through a workaround or indirect execution.',
        );
      if (message !== 'user rejected MCP tool call' && !automatic)
        throw new Error('dispatch-denial-unverified');
      if (automatic && approvedCallId !== match.item.id)
        throw new Error('dispatch-denial-approval-required');
      if (approvedCallId !== undefined && approvedCallId !== match.item.id)
        throw new Error('dispatch-denial-unverified');
      return { turnId: match.turn.id, callId: match.item.id };
    },
    async find(input: {
      sourceThreadId: string;
      prompt: string;
      createdAfter: number;
      threadId?: string;
    }): Promise<DispatchNativeThread | undefined> {
      if (input.threadId) {
        const thread = await read(input.threadId);
        return thread ? verify(thread, input) : undefined;
      }
      const matches: DispatchNativeThread[] = [];
      let cursor: string | undefined;
      let newestAllowed = Infinity;
      const cursors = new Set<string>();
      for (let page = 0; page < 10; page++) {
        const result = await request('thread/list', {
          limit: 100,
          sortKey: 'created_at',
          sortDirection: 'desc',
          sourceKinds: [
            'cli',
            'vscode',
            'exec',
            'appServer',
            'subAgent',
            'subAgentReview',
            'subAgentCompact',
            'subAgentThreadSpawn',
            'subAgentOther',
            'unknown',
          ],
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(result.data)) throw new Error('dispatch-native-response-invalid');
        for (const candidate of result.data) {
          if (
            !nativeObject(candidate) ||
            typeof candidate.id !== 'string' ||
            typeof candidate.createdAt !== 'number'
          )
            throw new Error('dispatch-native-response-invalid');
          if (candidate.createdAt > newestAllowed)
            throw new Error('dispatch-native-response-invalid');
          newestAllowed = candidate.createdAt;
          if (candidate.createdAt * 1000 < input.createdAfter - 2000) return matches[0];
          const thread = await read(candidate.id);
          if (thread && matchesDispatchCreation(thread, input.sourceThreadId, input.prompt)) {
            matches.push(await verify(thread, input));
            if (matches.length > 1) throw new Error('dispatch-native-identity-ambiguous');
          }
        }
        if (!result.nextCursor) return matches[0];
        if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor))
          throw new Error('dispatch-native-response-invalid');
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
      throw new Error('dispatch-native-search-incomplete');
    },
  };
}
