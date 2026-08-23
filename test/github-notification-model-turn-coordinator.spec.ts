import assert from 'node:assert/strict';

import type { AssembledInboundReply } from 'openclaw/plugin-sdk/channel-inbound';

import GitHubNotificationModelTurnCoordinator, {
  GitHubNotificationModelTurnCoordinatorError,
} from '../channels/github/conversation/model-turn-coordinator.ts';
import type { GitHubNotificationTurnContract } from '../channels/github/conversation/turn-contract.ts';
import { GitHubNotificationReplyCandidateStoreError } from '../channels/github/publication/reply-candidate-store.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import { GitHubNotificationPrivateResponseError } from '../channels/github/conversation/private-response.ts';

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
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      candidates: {
        async begin(candidateIdentity) {
          calls.push(['begin', candidateIdentity]);
          return 'turn-1';
        },
        async cancel() {
          throw new Error('successful turns must not be cancelled');
        },
        async finishWithMetadata(candidateIdentity) {
          calls.push(['finish', candidateIdentity]);
          return [{ body: '## Ready\n\n- `notification` checks passed' }];
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
  });

  it('should cancel the candidate handoff when model dispatch fails', async () => {
    const failure = new Error('dispatch failed');
    let cancellation: unknown;
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      candidates: {
        async begin() {
          return 'turn-1';
        },
        async cancel(input) {
          cancellation = input;
        },
        async finishWithMetadata() {
          throw new Error('failed turns must not finish candidates');
        },
      },
      dispatcher: {
        async dispatch() {
          throw failure;
        },
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
  });

  it('should retain a typed plan outcome and validate the private report', async () => {
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      candidates: {
        async begin() {
          return 'turn-1';
        },
        async cancel() {},
        async finishWithMetadata() {
          return [
            {
              body: 'I understand the user-facing problem and have a focused plan to address it.',
              outcome: 'plan' as const,
            },
          ];
        },
      },
      dispatcher: {
        async dispatch() {
          return {
            dispatch: { counts: { block: 0, final: 1, tool: 1 }, queuedFinal: false },
            finalPayloads: [
              {
                text: [
                  '## Assessment',
                  '',
                  'The user needs the expected result instead of the current failure.',
                  '',
                  '## Plan',
                  '',
                  'Update the owning behavior and verify it with focused tests.',
                ].join('\n'),
              },
            ],
          };
        },
      },
    });
    const planningContract = {
      ...contract,
      identity: { ...identity, eventId: 'assignment' as const },
      publicationIntent: 'planning-outcome' as const,
    };

    const result = await coordinator.run({ ...input(), contract: planningContract });

    assert.deepEqual(result.publication, {
      planningOutcome: 'plan',
      publicText: 'I understand the user-facing problem and have a focused plan to address it.',
      status: 'candidate',
    });
    assert.match(result.privateText, /^## Assessment[\s\S]+^## Plan$/mu);
  });

  it('should reject a planning response whose private headings do not match its outcome', async () => {
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      candidates: {
        async begin() {
          return 'turn-1';
        },
        async cancel() {},
        async finishWithMetadata() {
          return [
            { body: 'I need one answer before I can finish the plan.', outcome: 'questions' },
          ];
        },
      },
      dispatcher: {
        async dispatch() {
          return {
            dispatch: { counts: { block: 0, final: 1, tool: 1 }, queuedFinal: false },
            finalPayloads: [{ text: '## Question\n\nWhich behavior should win?' }],
          };
        },
      },
    });
    const planningContract = {
      ...contract,
      identity: { ...identity, eventId: 'assignment' as const },
      publicationIntent: 'planning-outcome' as const,
    };

    await assert.rejects(
      coordinator.run({ ...input(), contract: planningContract }),
      (error: unknown) =>
        error instanceof GitHubNotificationPrivateResponseError &&
        error.code === 'github-notification-planning-private-response-invalid',
    );
  });

  it('should classify a missing prompt-selection attestation', async () => {
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      candidates: {
        async begin() {
          return 'turn-1';
        },
        async cancel() {},
        async finishWithMetadata() {
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
    });

    await assert.rejects(
      coordinator.run(input()),
      (error: unknown) =>
        error instanceof GitHubNotificationModelTurnCoordinatorError &&
        error.code === 'github-notification-model-turn-prompt-selection-missing',
    );
  });
});
