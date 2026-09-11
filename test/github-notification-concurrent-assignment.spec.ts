import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import GitHubNotificationModelTurnCoordinator from '../channels/github/conversation/model-turn-coordinator.ts';
import GitHubNotificationModelTurnDispatcher from '../channels/github/conversation/model-turn-dispatcher.ts';
import type { GitHubNotificationTurnContract } from '../channels/github/conversation/turn-contract.ts';
import GitHubNotificationReplyCandidateStore, {
  type GitHubNotificationReplyCandidateFinishInput,
} from '../channels/github/publication/reply-candidate-store.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';

describe('github notification concurrent assignment', () => {
  it('should record unrelated sessions and finish isolated candidates while another assignment remains open', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-assignment-overlap-'));
    const rootDir = join(temporaryDirectory, 'state');
    const parent = new GitHubNotificationReplyCandidateStore({ rootDir });
    const executor = new GitHubNotificationReplyCandidateStore({ rootDir });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const completed: number[] = [];
    const acknowledged: number[] = [];
    const identity = { eventId: 'assignment', lifecycleId: 'issue', modeId: 'work' } as const;
    const contract = {
      identity,
      instructions: 'trusted assignment instructions',
      mode: { disableTools: false, id: 'work' },
      publicationIntent: 'assignment-response',
      publicationSource: 'candidate',
    } as GitHubNotificationTurnContract;

    const run = (number: number) => {
      const conversationId = `github:issue:R_repo:${number}`;
      const candidate = {
        agentId: 'tanaabot',
        conversationId,
        identity,
        sourceId: `assignment-${number}`,
      };
      const route = {
        accountId: candidate.agentId,
        agentId: candidate.agentId,
        channel: githubNotificationChannelId,
        conversationId,
        matchedBy: 'binding.account',
        sessionKey: `agent:tanaabot:agent-system-github:tanaabot:direct:${conversationId}`,
        workspaceDir: temporaryDirectory,
      } as const;
      const dispatcher = new GitHubNotificationModelTurnDispatcher({
        async dispatchChannelInboundTurn(input) {
          input.record?.trackSessionMetaTask?.(
            writeFile(join(temporaryDirectory, `session-${number}`), input.route.sessionKey).then(
              () => ({ sessionId: `session-${number}` }),
            ),
          );
          await input.afterRecord?.();
          await executor.attestPromptSelection(candidate);
          if (number === 1) {
            entered.resolve();
            await release.promise;
          }
          // retain the original invocation only when replaying this regression against 2fe15db.
          const binding =
            input.ctxPayload.GatewayRunToolBindings?.['agent-system.github-reply-turn'];
          const stage = executor.stage.bind(executor) as (
            turn: GitHubNotificationReplyCandidateFinishInput | string,
            body: string,
          ) => Promise<void>;
          await stage(
            (binding as GitHubNotificationReplyCandidateFinishInput | undefined) ??
              candidate.agentId,
            `I will resolve issue ${number}.`,
          );
          await input.delivery.deliver({ text: `Private plan ${number}.` }, { kind: 'final' });
          completed.push(number);
          return {
            dispatched: true,
            dispatchResult: { counts: { block: 0, final: 1, tool: 1 }, queuedFinal: false },
            routeSessionKey: input.route.sessionKey,
          } as never;
        },
      });
      return new GitHubNotificationModelTurnCoordinator({
        assertReady() {},
        candidates: parent,
        dispatcher,
        logger: { info() {}, warn() {} },
      }).run({
        afterRecord: async () => {
          assert.equal(
            await readFile(join(temporaryDirectory, `session-${number}`), 'utf8'),
            route.sessionKey,
          );
          acknowledged.push(number);
        },
        config: {},
        contract,
        createIfMissing: true,
        ctxPayload: { CommandAuthorized: false },
        executionSurface: 'gateway',
        messageId: candidate.sourceId,
        route,
        sourceId: candidate.sourceId,
      });
    };

    const first = run(1);
    try {
      await Promise.race([
        entered.promise,
        first.then(() => assert.fail('first turn did not remain open')),
      ]);
      const second = await run(2).catch(async (error: unknown) => {
        await assert.rejects(readFile(join(temporaryDirectory, 'session-2')), { code: 'ENOENT' });
        const code = error instanceof Error && 'code' in error ? error.code : 'unknown';
        throw new Error(`second assignment rejected: ${String(code)}; session-2 missing`, {
          cause: error,
        });
      });
      assert.match(await readFile(join(temporaryDirectory, 'session-2'), 'utf8'), /:2$/u);
      assert.deepEqual(completed, [2]);
      assert.deepEqual(second.publication, {
        status: 'candidate',
        publicText: 'I will resolve issue 2.',
      });
      release.resolve();
      assert.deepEqual((await first).publication, {
        status: 'candidate',
        publicText: 'I will resolve issue 1.',
      });
      assert.deepEqual(completed, [2, 1]);
      assert.deepEqual(acknowledged, [1, 2]);
    } finally {
      release.resolve();
      await first;
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
