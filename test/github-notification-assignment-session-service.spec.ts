import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import GitHubNotificationAssignmentSessionService from '../channels/github/conversation/assignment-session-service.ts';
import {
  createGitHubNotificationConversationState,
  type GitHubNotificationConversationState,
} from '../channels/github/conversation/conversation-state.ts';
import type {
  GitHubNotificationModelTurnCoordinatorInput,
  GitHubNotificationModelTurnCoordinatorResult,
} from '../channels/github/conversation/model-turn-coordinator.ts';
import type { GitHubNotificationTurnContract } from '../channels/github/conversation/turn-contract.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import { githubWorkItemKey } from '../channels/github/provider/work-item.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace';
const item = notificationMonitorState().items[notificationItemKey]!;
const assignmentEventId = item.assignmentEventNodeId;
const conversationId = githubNotificationConversationId({
  itemNumber: item.number,
  lifecycleId: item.lifecycleId,
  repositoryId: item.repositoryNodeId,
});
const config: OpenClawConfig = {
  agents: { list: [{ id: agentId, tools: { profile: 'coding' }, workspace: workspaceDir }] },
  bindings: [
    {
      agentId,
      match: { accountId: agentId, channel: githubNotificationChannelId },
      session: { dmScope: 'per-account-channel-peer' },
      type: 'route',
    },
  ],
  channels: {
    [githubNotificationChannelId]: { accounts: { [agentId]: { enabled: true } } },
  },
};
const lifecycle = new GitHubIssueLifecycle({
  async inspectGitHub() {
    return undefined;
  },
  async prepareGitHub() {
    throw new Error('not used');
  },
});
const contract = {
  identity: { eventId: 'assignment', lifecycleId: 'issue', modeId: 'work' },
  instructions: 'trusted assignment instructions',
  lifecycle,
  mode: { disableTools: false, id: 'work' },
  publicationIntent: 'assignment-response',
} as GitHubNotificationTurnContract;
const input = {
  agentId,
  executionSurface: 'cli-one-shot' as const,
  item,
  lifecycle,
  mode: githubNotificationWorkMode,
  workspaceDir,
  worktree: { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
};

function initialState(): GitHubNotificationConversationState {
  const state = createGitHubNotificationConversationState(agentId, workspaceDir);
  state.conversations[conversationId] = {
    baselineEstablished: false,
    itemKey: githubWorkItemKey(item.repositoryNodeId, item.number),
    lifecycleId: 'issue',
    mode: 'work',
    revisions: {},
  };
  return state;
}

function candidateResult(): GitHubNotificationModelTurnCoordinatorResult {
  return {
    dispatch: { counts: { block: 0, final: 1, tool: 1 }, queuedFinal: false },
    finalPayloadCount: 1,
    privateText: '## Assessment\n\nUser-centric assessment.\n\n## Plan\n\nTechnical plan.',
    publication: { publicText: 'I understand the issue and have a plan.', status: 'candidate' },
  };
}

interface HarnessOptions {
  publicationFailures?: number;
  result?: GitHubNotificationModelTurnCoordinatorResult;
  turnFailures?: number;
  verifyRun?(input: GitHubNotificationModelTurnCoordinatorInput): void;
}

function harness(options: HarnessOptions = {}) {
  let state = initialState();
  const counts = { acknowledgments: 0, dispatches: 0, publications: 0 };
  const service = new GitHubNotificationAssignmentSessionService({
    acknowledgments: {
      async publish(acknowledgment) {
        counts.acknowledgments += 1;
        assert.equal(acknowledgment.item, item);
        assert.equal(acknowledgment.modeId, 'work');
      },
    },
    conversationStateStore: {
      async read() {
        return structuredClone(state);
      },
      async write(next) {
        state = structuredClone(next);
      },
    },
    coordinator: {
      async run(turnInput) {
        counts.dispatches += 1;
        assert.deepEqual(state.conversations[conversationId]?.activeTurn, {
          eventId: 'assignment',
          sourceId: assignmentEventId,
        });
        options.verifyRun?.(turnInput);
        if (counts.dispatches <= (options.turnFailures ?? 0)) throw new Error('turn interrupted');
        return options.result ?? candidateResult();
      },
    },
    logger: { error() {}, info() {}, warn() {} },
    publications: {
      async publish(publication) {
        counts.publications += 1;
        const checkpoint = state.conversations[conversationId]?.assignmentResponse;
        assert.equal(checkpoint?.status, 'pending');
        if (checkpoint?.status !== 'pending') throw new Error('missing pending checkpoint');
        assert.equal(publication.target, checkpoint.target);
        assert.equal(publication.text, checkpoint.publicText);
        if (counts.publications <= (options.publicationFailures ?? 0)) {
          throw new Error('publication interrupted');
        }
        return {
          receipt: { databaseId: 44, nodeId: 'IC_assignment-response' },
          status: 'published' as const,
          target: publication.target,
        };
      },
    },
    readConfig: async () => config,
    turnContracts: {
      resolve(identity, resolvedConfig, resolvedAgentId) {
        assert.deepEqual(identity, {
          eventId: 'assignment',
          lifecycleId: 'issue',
          modeId: 'work',
        });
        assert.equal(resolvedConfig, config);
        assert.equal(resolvedAgentId, agentId);
        return contract;
      },
    },
  });
  return {
    counts,
    prepare: () => service.prepare(input),
    state: () => state,
  };
}

describe('channels/github/conversation/assignment-session-service', () => {
  it('should run and publish one assignment through the shared model-turn boundary', async () => {
    const scenario = harness({
      verifyRun(turnInput) {
        assert.equal(turnInput.contract, contract);
        assert.equal(turnInput.createIfMissing, true);
        assert.equal(turnInput.executionSurface, 'cli-one-shot');
        assert.equal(turnInput.messageId, `assignment:${assignmentEventId}`);
        assert.equal(turnInput.sourceId, assignmentEventId);
        assert.equal(turnInput.ctxPayload.Provider, githubNotificationChannelId);
        assert.match(
          turnInput.ctxPayload.Body ?? '',
          /Please begin working on it in `work` mode\./u,
        );
      },
    });

    await scenario.prepare();
    await scenario.prepare();

    assert.deepEqual(scenario.counts, { acknowledgments: 2, dispatches: 1, publications: 1 });
    const response = scenario.state().conversations[conversationId]?.assignmentResponse;
    assert.equal(scenario.state().conversations[conversationId]?.activeTurn, undefined);
    assert.equal(response?.status, 'published');
    if (response?.status !== 'published') throw new Error('missing published response');
    assert.equal(response.commentDatabaseId, 44);
    assert.equal(response.publicText, 'I understand the issue and have a plan.');
    assert.match(response.publicTextDigest, /^[a-f0-9]{64}$/u);
    assert.match(response.target, /:publication:assignment-response:[a-f0-9]{32}$/u);
  });

  it('should retry a pending publication without another model turn', async () => {
    const scenario = harness({ publicationFailures: 1 });

    await assert.rejects(scenario.prepare(), /publication interrupted/u);
    assert.equal(
      scenario.state().conversations[conversationId]?.assignmentResponse?.status,
      'pending',
    );
    await scenario.prepare();

    assert.deepEqual(scenario.counts, { acknowledgments: 2, dispatches: 1, publications: 2 });
    assert.equal(
      scenario.state().conversations[conversationId]?.assignmentResponse?.status,
      'published',
    );
  });

  it('should retain the active assignment descriptor for a model-turn retry', async () => {
    const scenario = harness({ turnFailures: 1 });

    await assert.rejects(scenario.prepare(), /turn interrupted/u);
    assert.deepEqual(scenario.state().conversations[conversationId]?.activeTurn, {
      eventId: 'assignment',
      sourceId: assignmentEventId,
    });
    await scenario.prepare();

    assert.deepEqual(scenario.counts, { acknowledgments: 2, dispatches: 2, publications: 1 });
    assert.equal(scenario.state().conversations[conversationId]?.activeTurn, undefined);
  });

  it('should checkpoint a withheld response without publication', async () => {
    const scenario = harness({
      result: {
        ...candidateResult(),
        publication: {
          code: 'github-notification-publication-candidate-missing',
          status: 'withheld',
        },
      },
    });

    await scenario.prepare();
    await scenario.prepare();

    assert.deepEqual(scenario.counts, { acknowledgments: 2, dispatches: 1, publications: 0 });
    assert.deepEqual(scenario.state().conversations[conversationId]?.assignmentResponse, {
      reasonCode: 'github-notification-publication-candidate-missing',
      status: 'withheld',
    });
  });
});
