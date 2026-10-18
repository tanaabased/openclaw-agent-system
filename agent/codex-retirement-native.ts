import { nativeObject } from './automation-gateway.ts';
import codexTurnApprovalDenied from './codex-turn-approval.ts';
import creationHistory from './codex-dispatch-creation-history.ts';
import type { CodexThreadRequest } from './codex-thread-client.ts';

/** desktop resource effects stay in native tools; this adapter only reads custody evidence. */
export default function codexRetirementNative(request: CodexThreadRequest) {
  return {
    async worktreeUsers(cwd: string): Promise<string[]> {
      const users: string[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 20; page++) {
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
          if (row.cwd === cwd) users.push(row.id);
        }
        if (result.nextCursor == null) return users;
        if (
          typeof result.nextCursor !== 'string' ||
          !result.nextCursor ||
          seen.has(result.nextCursor)
        )
          throw new Error('retirement-native-inventory-invalid');
        seen.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      throw new Error('retirement-native-inventory-incomplete');
    },
    async archiveOutcome(
      sourceThreadId: string,
      threadId: string,
      attempt: { at: number; turnId: string },
      currentTurnId: string,
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
