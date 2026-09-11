import assert from 'node:assert/strict';

import type { AssembledInboundReply } from 'openclaw/plugin-sdk/channel-inbound';

import GitHubNotificationModelTurnCoordinator, {
  GitHubNotificationModelTurnCoordinatorError,
} from '../channels/github/conversation/model-turn-coordinator.ts';
import { GitHubNotificationPrivateResponseError } from '../channels/github/conversation/private-response.ts';
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
  publicationSource: 'final',
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
  it('should block before candidate creation or dispatch when the required hook is unavailable', async () => {
    let candidateStarted = false;
    let dispatched = false;
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      assertReady() {
        throw new Error('required hook unavailable');
      },
      candidates: {
        async begin() {
          candidateStarted = true;
          return 'unexpected';
        },
        async attestPromptSelection() {},
        async cancel() {},
        async finish() {
          return [];
        },
      },
      dispatcher: {
        async dispatch() {
          dispatched = true;
          throw new Error('unexpected dispatch');
        },
      },
      logger: { info() {}, warn() {} },
    });
    await assert.rejects(coordinator.run(input()), /required hook unavailable/u);
    assert.equal(candidateStarted, false);
    assert.equal(dispatched, false);
  });

  it('should publish the ordinary final response and retain it privately', async () => {
    const calls: unknown[] = [];
    const messages: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      assertReady() {},
      candidates: {
        async attestPromptSelection(candidateIdentity) {
          calls.push(['attest', candidateIdentity]);
        },
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
            dispatch: { counts: { block: 0, final: 3, tool: 1 }, queuedFinal: false },
            finalPayloads: [
              { isReasoning: true, text: 'Internal reasoning.' },
              { isStatusNotice: true, text: 'Tool execution completed.' },
              { text: 'Complete private response.' },
            ],
          };
        },
      },
      logger: {
        info: (message) => messages.push(message),
        warn() {},
      },
    });

    assert.deepEqual(await coordinator.run({ ...input(), executionSurface: 'cli-one-shot' }), {
      dispatch: { counts: { block: 0, final: 3, tool: 1 }, queuedFinal: false },
      finalPayloadCount: 3,
      privateText: 'Complete private response.',
      publication: {
        status: 'candidate',
        publicText: 'Complete private response.',
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
      [
        'attest',
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
      /model turn started agent=tanaabot lifecycle=issue mode=work event=comment surface=cli-one-shot/u,
    );
    assert.match(
      messages[1] ?? '',
      /model turn completed .*final-payloads=3 block=0 final=3 tool=1 queued-final=false candidates=1 publication=candidate aborted=false/u,
    );
  });

  it('should coordinate a private turn without requiring a publication candidate', async () => {
    const messages: string[] = [];
    const warnings: string[] = [];
    const stagedCandidates: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      assertReady() {},
      candidates: {
        async attestPromptSelection() {
          throw new Error('gateway turns must use the prompt hook');
        },
        async begin() {
          return 'turn-1';
        },
        async cancel() {},
        async finish() {
          return [...stagedCandidates];
        },
      },
      dispatcher: {
        async dispatch() {
          return {
            dispatch: { counts: { block: 0, final: 1, tool: 2 }, queuedFinal: false },
            finalPayloads: [{ text: '## Implementation\n\nComplete.' }],
          };
        },
      },
      logger: {
        info: (message) => messages.push(message),
        warn: (message) => warnings.push(message),
      },
    });
    const privateContract = {
      ...contract,
      identity: { ...identity, eventId: 'implementation' as const },
      publicationIntent: undefined,
      publicationSource: undefined,
    };

    const result = await coordinator.run({
      ...input(),
      contract: privateContract,
      messageId: 'implementation:EV_assignment',
      sourceId: 'EV_assignment',
    });

    assert.equal(result.privateText, '## Implementation\n\nComplete.');
    assert.deepEqual(result.publication, { status: 'none' });
    assert.match(messages[1] ?? '', /event=implementation .*candidates=0 publication=none/u);

    stagedCandidates.push('This must not be published.');
    assert.deepEqual(
      (
        await coordinator.run({
          ...input(),
          contract: privateContract,
          messageId: 'implementation:EV_other',
          sourceId: 'EV_other',
        })
      ).publication,
      {
        code: 'github-notification-publication-candidate-unexpected',
        status: 'withheld',
      },
    );
    assert.match(
      warnings[0] ?? '',
      /event=implementation .*candidates=1 publication=withheld code=github-notification-publication-candidate-unexpected/u,
    );
  });

  it('should cancel the candidate handoff when model dispatch fails', async () => {
    const failure = new Error('dispatch failed');
    let cancellation: unknown;
    const warnings: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      assertReady() {},
      candidates: {
        async attestPromptSelection() {
          throw new Error('gateway turns must use the prompt hook');
        },
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

  it('should log the failure code without private response content', async () => {
    const warnings: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      assertReady() {},
      candidates: {
        async attestPromptSelection() {},
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
            dispatch: { counts: { block: 0, final: 2, tool: 0 }, queuedFinal: false },
            finalPayloads: [{ text: 'sensitive one' }, { text: 'sensitive two' }],
          };
        },
      },
      logger: {
        info() {},
        warn: (message) => warnings.push(message),
      },
    });

    await assert.rejects(coordinator.run(input()), GitHubNotificationPrivateResponseError);
    assert.match(
      warnings[0] ?? '',
      /phase=private-response code=github-notification-private-response-invalid aborted=false/u,
    );
    assert.doesNotMatch(warnings[0] ?? '', /sensitive|one|two/u);
  });

  it('should warn with bounded diagnostics when publication is withheld', async () => {
    const warnings: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      assertReady() {},
      candidates: {
        async attestPromptSelection() {
          throw new Error('gateway turns must use the prompt hook');
        },
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

    const candidateContract = {
      ...contract,
      identity: { ...identity, eventId: 'assignment' as const },
      publicationIntent: 'assignment-response' as const,
      publicationSource: 'candidate' as const,
    };

    assert.deepEqual(
      (await coordinator.run({ ...input(), contract: candidateContract })).publication,
      {
        code: 'github-notification-publication-candidate-missing',
        status: 'withheld',
      },
    );
    assert.match(
      warnings[0] ?? '',
      /event=assignment .*final-payloads=1 block=2 final=1 tool=0 queued-final=false candidates=0 publication=withheld code=github-notification-publication-candidate-missing aborted=false/u,
    );
  });

  it('should report a value-free publication safety category', async () => {
    const warnings: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      assertReady() {},
      candidates: {
        async attestPromptSelection() {
          throw new Error('gateway turns must use the prompt hook');
        },
        async begin() {
          return 'turn-1';
        },
        async cancel() {},
        async finish() {
          return ['See @pirog for the private result.'];
        },
      },
      dispatcher: {
        async dispatch() {
          return {
            dispatch: { counts: { block: 0, final: 1, tool: 1 }, queuedFinal: false },
            finalPayloads: [{ text: 'Complete private response.' }],
          };
        },
      },
      logger: {
        info() {},
        warn: (message) => warnings.push(message),
      },
    });

    const candidateContract = {
      ...contract,
      identity: { ...identity, eventId: 'assignment' as const },
      publicationIntent: 'assignment-response' as const,
      publicationSource: 'candidate' as const,
    };

    assert.deepEqual(
      (await coordinator.run({ ...input(), contract: candidateContract })).publication,
      {
        code: 'github-notification-publication-secret-safety-rejected',
        safetyCategory: 'mention',
        status: 'withheld',
      },
    );
    assert.match(
      warnings[0] ?? '',
      /publication=withheld code=github-notification-publication-secret-safety-rejected safety=mention aborted=false/u,
    );
    assert.doesNotMatch(warnings[0] ?? '', /private result|@pirog/u);
  });

  it('should publish a safe notice when an ordinary final response fails safety validation', async () => {
    const warnings: string[] = [];
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      assertReady() {},
      candidates: {
        async attestPromptSelection() {
          throw new Error('gateway turns must use the prompt hook');
        },
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
            dispatch: { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: false },
            finalPayloads: [{ text: 'See @pirog for the private result.' }],
          };
        },
      },
      logger: {
        info() {},
        warn: (message) => warnings.push(message),
      },
    });

    assert.deepEqual((await coordinator.run(input())).publication, {
      fallbackCode: 'github-notification-publication-secret-safety-rejected',
      publicText:
        "I received your comment, but I couldn't safely publish the detailed response. I've kept it in the linked private session for review.",
      safetyCategory: 'mention',
      status: 'candidate',
    });
    assert.match(
      warnings[0] ?? '',
      /publication=candidate fallback=github-notification-publication-secret-safety-rejected safety=mention aborted=false/u,
    );
    assert.doesNotMatch(warnings[0] ?? '', /private result|@pirog/u);
  });

  it('should classify a missing prompt-selection attestation', async () => {
    const coordinator = new GitHubNotificationModelTurnCoordinator({
      assertReady() {},
      candidates: {
        async attestPromptSelection() {
          throw new Error('gateway turns must use the prompt hook');
        },
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
