import { nativeObject } from './automation-gateway.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';
import creationHistory from './codex-dispatch-creation-history.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

function helperParent(thread: Record<string, unknown>): string | undefined {
  const source = thread.source;
  if (!nativeObject(source) || !nativeObject(source.subAgent)) return undefined;
  if (
    source.subAgent.other === 'guardian' &&
    thread.threadSource === 'guardian_review' &&
    typeof thread.parentThreadId === 'string' &&
    thread.forkedFromId == null
  )
    return thread.parentThreadId;
  const spawn = source.subAgent.thread_spawn;
  return nativeObject(spawn) &&
    typeof spawn.parent_thread_id === 'string' &&
    thread.parentThreadId === spawn.parent_thread_id &&
    thread.forkedFromId == null
    ? spawn.parent_thread_id
    : undefined;
}

/** desktop resource effects stay in native tools; this adapter only reads custody evidence. */
export default function codexRetirementNative(request: CodexThreadRequest) {
  return {
    async worktreeUsers(
      cwd: string,
      retiringOwners: ReadonlySet<string> = new Set(),
      protectedThreads: ReadonlySet<string> = new Set(),
    ): Promise<string[]> {
      const users = new Map<string, Record<string, unknown>>();
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (;;) {
        const result = await request('thread/list', {
          archived: false,
          limit: 100,
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
        if (!Array.isArray(result.data)) throw new Error('retirement-native-inventory-invalid');
        for (const row of result.data) {
          if (!nativeObject(row) || typeof row.id !== 'string' || typeof row.cwd !== 'string')
            throw new Error('retirement-native-inventory-invalid');
          if (row.cwd === cwd) users.set(row.id, row);
        }
        if (result.nextCursor == null) break;
        if (
          typeof result.nextCursor !== 'string' ||
          !result.nextCursor ||
          seen.has(result.nextCursor)
        )
          throw new Error('retirement-native-inventory-invalid');
        seen.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      const owners = new Set(retiringOwners);
      const helpers = [...users.values()].filter(
        (row) =>
          !owners.has(String(row.id)) &&
          nativeObject(row.source) &&
          nativeObject(row.source.subAgent),
      );
      // list metadata can omit guardian parentage; read each candidate before classifying ownership.
      const parents = new Map<string, string>();
      for (const row of helpers) {
        const id = String(row.id);
        if (protectedThreads.has(id)) continue;
        const { thread } = await request('thread/read', { threadId: id, includeTurns: false });
        if (
          !nativeObject(thread) ||
          thread.id !== id ||
          thread.cwd !== cwd ||
          !nativeObject(thread.status) ||
          !['idle', 'notLoaded'].includes(String(thread.status.type))
        )
          continue;
        const parent = helperParent(thread);
        if (!parent) continue;
        const turns = await request('thread/turns/list', {
          threadId: id,
          limit: 1,
          sortDirection: 'desc',
          itemsView: 'notLoaded',
        });
        const last = Array.isArray(turns.data) && turns.data.length === 1 ? turns.data[0] : null;
        // guardian reviews can finish without a retained ordinary turn; parentage comes from read.
        const emptyGuardian =
          thread.threadSource === 'guardian_review' &&
          nativeObject(thread.source) &&
          nativeObject(thread.source.subAgent) &&
          thread.source.subAgent.other === 'guardian' &&
          Array.isArray(turns.data) &&
          turns.data.length === 0 &&
          turns.nextCursor == null;
        if (
          !emptyGuardian &&
          (!nativeObject(last) ||
            last.status !== 'completed' ||
            typeof last.completedAt !== 'number' ||
            !Number.isFinite(last.completedAt))
        )
          continue;
        parents.set(id, parent);
      }
      // only settled descendants of retiring owners can share their parent's cleanup.
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, parent] of parents) {
          if (owners.has(id) || !owners.has(parent)) continue;
          owners.add(id);
          changed = true;
        }
      }
      return [...users.keys()].filter((id) => retiringOwners.has(id) || !owners.has(id));
    },
    async archiveOutcome(
      sourceThreadId: string,
      threadId: string,
      attempt: { at: number; turnId: string },
      currentTurnId?: string,
    ): Promise<'unsubmitted' | 'denied' | 'unverified'> {
      const history = await creationHistory(
        request,
        sourceThreadId,
        { createdAt: attempt.at, turnId: attempt.turnId },
        currentTurnId,
      );
      if (!history) return 'unverified';
      const matches: Record<string, unknown>[] = [];
      let uncertain = false;
      for (const turn of history.turns) {
        for (const item of turn.items as Record<string, unknown>[]) {
          if (
            [
              'userMessage',
              'agentMessage',
              'reasoning',
              'plan',
              'contextCompaction',
              'sleep',
              'webSearch',
            ].includes(String(item.type))
          )
            continue;
          if (
            item.type === 'commandExecution' &&
            (turn.id === currentTurnId ||
              ['completed', 'failed', 'declined'].includes(String(item.status)))
          )
            continue;
          if (
            item.type !== 'mcpToolCall' ||
            typeof item.tool !== 'string' ||
            typeof item.server !== 'string' ||
            !['completed', 'failed'].includes(String(item.status))
          ) {
            uncertain = true;
            continue;
          }
          if (item.tool !== 'set_thread_archived') continue;
          if (
            item.server !== 'codex_app' ||
            !nativeObject(item.arguments) ||
            typeof item.arguments.threadId !== 'string'
          ) {
            uncertain = true;
            continue;
          }
          if (item.arguments.threadId !== threadId) continue;
          if (
            item.arguments.archived !== true ||
            (item.arguments.hostId !== undefined && item.arguments.hostId !== 'local')
          ) {
            uncertain = true;
            continue;
          }
          matches.push(item);
        }
      }
      if (uncertain) return 'unverified';
      if (!matches.length) return 'unsubmitted';
      return matches.length === 1 && codexTurnApprovalDenied(matches) ? 'denied' : 'unverified';
    },
  };
}
