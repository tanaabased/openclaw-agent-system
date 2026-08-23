import assert from 'node:assert/strict';

import type { AssembledInboundReply } from 'openclaw/plugin-sdk/channel-inbound';

import GitHubNotificationModelTurnCoordinator, {
  GitHubNotificationModelTurnCoordinatorError,
} from '../channels/github/conversation/model-turn-coordinator.ts';
import type { GitHubNotificationTurnContract } from '../channels/github/conversation/turn-contract.ts';
import { GitHubNotificationReplyCandidateStoreError } from '../channels/github/publication/reply-candidate-store.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';

const identity = { eventId: 'comment', lifecycleId: 'issue', modeId: 'work' } as const;
const route = {
  accountId: 'tanaabot',
  agentId: 'tanaabot',
  channel: githubNotificationChannelId,
  conversationId: 'github:issue:R_repo:12',
  matchedBy: 'binding.account',
  sessionKey: 'agent:tanaabot:agent-system-github:tanaabot:direct:github:issue:R_repo:12',
  workspaceDir: '/workspace/tanaabot',
} as const;
const contract = {
  identity,
  instructions: 'trusted instructions',
  lifecycle: {},
  mode: { disableTools: false, id: 'work' },
  publicationIntent: 'github-reply',
} as GitHubNotificationTurnContract;
const ctxPayload = {} as AssembledInboundReply['ctxPayload'];

function input() {
  return {
    config: {},
    contract,
    ctxPayload,
    executionSurface: 'gateway' as const,
    messageId: 'comment:revision-1',
    route,
    sourceId: 'revision-1',
  };
}

describe('channels/github/conversation/model-turn-coordinator', () => {
  it('should coordinate one private response and one typed public candidate', async () => {
    const calls: unknown[] = [];
    const messages: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      candidates: {
        async begin(candidateIdentity) {
          calls.push(['begin', candidateIdentity]);
          return 'turn-1';
        },
        async cancel() {
          throw new Error('successful turns must not be cancelled');
        },
        async finish(candidateIdentity) {
          calls.push(['finish', candidateIdentity]);
          return ['## Ready\n\n- `notification` checks passed'];
        },
      },
      dispatcher: {
        async dispatch(dispatchInput) {
          calls.push(['dispatch', dispatchInput.messageId]);
          return {
            dispatch: { counts: { block: 0, final: 1, tool: 1 }, queuedFinal: false },
            finalPayloads: [{ text: 'Complete private response.' }],
          };
        },
      },
      logger: {
        info: (message) => messages.push(message),
        warn() {},
      },
    });

    assert.deepEqual(await coordinator.run(input()), {
      dispatch: { counts: { block: 0, final: 1, tool: 1 }, queuedFinal: false },
      finalPayloadCount: 1,
      privateText: 'Complete private response.',
      publication: {
        status: 'candidate',
        publicText: '## Ready\n\n- `notification` checks passed',
      },
    });
    assert.deepEqual(calls, [
      [
        'begin',
        {
          agentId: 'tanaabot',
          conversationId: route.conversationId,
          identity,
          sourceId: 'revision-1',
        },
      ],
      ['dispatch', 'comment:revision-1'],
      [
        'finish',
        {
          agentId: 'tanaabot',
          conversationId: route.conversationId,
          identity,
          sourceId: 'revision-1',
          turnId: 'turn-1',
        },
      ],
    ]);
    assert.match(
      messages[0] ?? '',
      /model turn started agent=tanaabot lifecycle=issue mode=work event=comment surface=gateway/u,
    );
    assert.match(
      messages[1] ?? '',
      /model turn completed .*final-payloads=1 block=0 final=1 tool=1 queued-final=false candidates=1 publication=candidate aborted=false/u,
    );
  });

  it('should cancel the candidate handoff when model dispatch fails', async () => {
    const failure = new Error('dispatch failed');
    let cancellation: unknown;
    const warnings: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      candidates: {
        async begin() {
          return 'turn-1';
        },
        async cancel(input) {
          cancellation = input;
        },
        async finish() {
          throw new Error('failed turns must not finish candidates');
        },
      },
      dispatcher: {
        async dispatch() {
          throw failure;
        },
      },
      logger: {
        info() {},
        warn: (message) => warnings.push(message),
      },
    });

    await assert.rejects(coordinator.run(input()), (error: unknown) => error === failure);
    assert.deepEqual(cancellation, {
      agentId: 'tanaabot',
      conversationId: route.conversationId,
      identity,
      sourceId: 'revision-1',
      turnId: 'turn-1',
    });
    assert.match(
      warnings[0] ?? '',
      /model turn failed .*event=comment .*phase=dispatch code=unclassified aborted=false/u,
    );
  });

  it('should warn with bounded diagnostics when publication is withheld', async () => {
    const warnings: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      candidates: {
        async begin() {
          return 'turn-1';
        },
        async cancel() {},
        async finish() {
          return [];
        },
      },
      dispatcher: {
        async dispatch() {
          return {
            dispatch: { counts: { block: 2, final: 1, tool: 0 }, queuedFinal: false },
            finalPayloads: [{ text: 'Complete private response.' }],
          };
        },
      },
      logger: {
        info() {},
        warn: (message) => warnings.push(message),
      },
    });

    assert.deepEqual((await coordinator.run(input())).publication, {
      code: 'github-notification-publication-candidate-missing',
      status: 'withheld',
    });
    assert.match(
      warnings[0] ?? '',
      /model turn completed .*final-payloads=1 block=2 final=1 tool=0 queued-final=false candidates=0 publication=withheld code=github-notification-publication-candidate-missing aborted=false/u,
    );
  });

  it('should classify a missing prompt-selection attestation', async () => {
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      candidates: {
        async begin() {
          return 'turn-1';
        },
        async cancel() {},
        async finish() {
          throw new GitHubNotificationReplyCandidateStoreError(
            'reply-turn-prompt-selection-missing',
          );
        },
      },
      dispatcher: {
        async dispatch() {
          return {
            dispatch: { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false },
            finalPayloads: [{ text: 'Complete private response.' }],
          };
        },
      },
      logger: { info() {}, warn() {} },
    });

    await assert.rejects(
      coordinator.run(input()),
      (error: unknown) =>
        error instanceof GitHubNotificationModelTurnCoordinatorError &&
        error.code === 'github-notification-model-turn-prompt-selection-missing',
    );
  });
});
