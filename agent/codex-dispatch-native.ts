import { realpath } from 'node:fs/promises';

import codexDirectInput from './codex-direct-input.ts';
import dispatchHistory, { dispatchHistoryPages } from './codex-dispatch-history.ts';
import intakeDenial from './codex-intake-denial.ts';
import creationHistory from './codex-dispatch-creation-history.ts';
import unsubmittedCreation from './codex-dispatch-unsubmitted.ts';

import { nativeObject } from './automation-gateway.ts';
import { automationHash } from './automation-hash.ts';
import codexAssessmentSkill from './codex-assessment-skill.ts';
import { CodexThreadRpcError, type CodexThreadRequest } from './codex-thread-client.ts';

export interface DispatchNativeThread {
  id: string;
  cwd: string;
  name?: string;
  model?: string;
  effort?: string;
  status: string;
  archived?: boolean;
  turnStatus?: string;
  turnEnded?: boolean;
  turnId?: string;
  followUpUserTurn?: boolean;
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

/** verify native history and titles without creating chats or parsing filesystem history. */
export function codexDispatchNative(request: CodexThreadRequest) {
  async function read(
    id: string,
    history: 'none' | 'edges' | 'all' = 'edges',
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const result = await request('thread/read', { threadId: id, includeTurns: false });
      if (!nativeObject(result.thread) || result.thread.id !== id)
        throw new Error('dispatch-native-response-invalid');
      return {
        ...result.thread,
        ...(history === 'none'
          ? {}
          : { turns: await dispatchHistory(request, id, history === 'all') }),
      };
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
    input: { sourceThreadId: string; prompt: string; observationOnly?: boolean },
  ): Promise<DispatchNativeThread> {
    if (
      !matchesDispatchCreation(thread, input.sourceThreadId, input.prompt) ||
      typeof thread.id !== 'string' ||
      typeof thread.cwd !== 'string' ||
      !nativeObject(thread.status) ||
      typeof thread.status.type !== 'string' ||
      thread.ephemeral === true ||
      (!input.observationOnly &&
        (thread.canAcceptDirectInput === false ||
          (typeof thread.path === 'string' &&
            thread.path.split(/[\\/]/u).includes('archived_sessions'))))
    )
      throw new Error('dispatch-native-readback-diverged');
    const latestTurn = Array.isArray(thread.turns) ? thread.turns.at(-1) : undefined;
    return {
      id: thread.id,
      cwd: input.observationOnly ? thread.cwd : await realpath(thread.cwd),
      status: thread.status.type,
      archived:
        thread.archived === true ||
        (typeof thread.path === 'string' &&
          thread.path.split(/[\\/]/u).includes('archived_sessions')),
      // a separate app-server can report a live desktop turn as interrupted/notLoaded.
      turnEnded:
        nativeObject(latestTurn) &&
        ['completed', 'failed', 'interrupted'].includes(String(latestTurn.status)) &&
        typeof latestTurn.completedAt === 'number' &&
        Number.isFinite(latestTurn.completedAt) &&
        latestTurn.completedAt > 0,
      followUpUserTurn:
        Array.isArray(thread.turns) &&
        thread.turns.length > 1 &&
        nativeObject(latestTurn) &&
        Array.isArray(latestTurn.items) &&
        latestTurn.items.some((item) => nativeObject(item) && item.type === 'userMessage'),
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
    intakeDenial: (
      record: Parameters<typeof intakeDenial>[1],
      observingPreparation = false,
      recoveryCallId?: string,
    ) => intakeDenial(request, record, observingPreparation, recoveryCallId),
    async intakeBoundary(threadId: string, turnId: string) {
      const items = await dispatchHistoryPages(request, 'thread/items/list', {
        threadId,
        turnId,
        sortDirection: 'asc',
      });
      const last = items.at(-1);
      if (
        !last ||
        last.turnId !== turnId ||
        !nativeObject(last.item) ||
        typeof last.item.id !== 'string'
      )
        throw new Error('dispatch-denial-history-unavailable');
      return last.item.id;
    },
    unsubmittedCreation: (
      threadId: string,
      prepared: { createdAt: number; turnId?: string; prompt?: string },
      currentTurnId: string,
    ) => unsubmittedCreation(request, threadId, prepared, currentTurnId),
    operatorInput: (threadId: string) => codexDirectInput(request, threadId),
    async occurrence(threadId: string) {
      const result = await request('thread/turns/list', {
        threadId,
        itemsView: 'notLoaded',
        sortDirection: 'desc',
        limit: 1,
      });
      const turn = Array.isArray(result.data) && result.data[0];
      if (!nativeObject(turn) || typeof turn.id !== 'string')
        throw new Error('dispatch-native-turn-unavailable');
      const items = await request('thread/items/list', {
        threadId,
        turnId: turn.id,
        sortDirection: 'asc',
        limit: 1,
      });
      const entry = Array.isArray(items.data) && items.data[0];
      const item = nativeObject(entry) && entry.turnId === turn.id && entry.item;
      const content = nativeObject(item) && item.type === 'userMessage' && item.content;
      const text = Array.isArray(content) && content[0];
      const match =
        nativeObject(text) && text.type === 'text' && typeof text.text === 'string'
          ? /^<heartbeat>\s*<automation_id>([^<]+)<\/automation_id>\s*<current_time_iso>([^<]+)<\/current_time_iso>/u.exec(
              text.text,
            )
          : null;
      if (!match || !Number.isFinite(Date.parse(match[2]!)))
        throw new Error('dispatch-native-occurrence-unavailable');
      return { id: turn.id, automationId: match[1]!, currentTimeIso: match[2]! };
    },
    assessmentSkill: (cwd: string, id: string) => codexAssessmentSkill(request, cwd, id),
    async rename(threadId: string, title: string) {
      await request('thread/name/set', { threadId, name: title });
      if ((await read(threadId, 'none'))?.name !== title)
        throw new Error('dispatch-native-title-diverged');
    },
    async deniedCreation(
      sourceThreadId: string,
      expected: Record<string, unknown>,
      prepared: { createdAt: number; turnId?: string },
      approvedCallId?: string,
    ) {
      const source = await read(sourceThreadId, 'none');
      const history = await creationHistory(request, sourceThreadId, prepared);
      if (
        !source ||
        !nativeObject(source.status) ||
        !['idle', 'notLoaded'].includes(String(source.status.type)) ||
        !history
      )
        throw new Error('dispatch-denial-unverified');
      const matches = history.turns.flatMap((turn) =>
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
      observationOnly?: boolean;
    }): Promise<DispatchNativeThread | undefined> {
      if (input.threadId) {
        const thread = await read(input.threadId);
        return thread ? verify(thread, input) : undefined;
      }
      const matches: DispatchNativeThread[] = [];
      for (const archived of input.observationOnly ? [false, true] : [false]) {
        let cursor: string | undefined;
        let newestAllowed = Infinity;
        const cursors = new Set<string>();
        let complete = false;
        pages: for (let page = 0; page < 10; page++) {
          const result = await request('thread/list', {
            limit: 100,
            ...(input.observationOnly ? { archived } : {}),
            sortKey: 'created_at',
            sortDirection: 'desc',
            // the ambient provider default can exclude native desktop-created chats.
            modelProviders: [],
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
            if (candidate.createdAt * 1000 < input.createdAfter - 2000) {
              complete = true;
              break pages;
            }
            const thread = await read(candidate.id);
            if (thread && matchesDispatchCreation(thread, input.sourceThreadId, input.prompt)) {
              matches.push(await verify(thread, input));
              if (matches.length > 1) throw new Error('dispatch-native-identity-ambiguous');
            }
          }
          if (!result.nextCursor) {
            complete = true;
            break;
          }
          if (typeof result.nextCursor !== 'string' || cursors.has(result.nextCursor))
            throw new Error('dispatch-native-response-invalid');
          cursor = result.nextCursor;
          cursors.add(cursor);
        }
        if (!complete) throw new Error('dispatch-native-search-incomplete');
      }
      return matches[0];
    },
  };
}
