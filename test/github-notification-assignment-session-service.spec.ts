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
const assignmentContract = {
  identity: { eventId: 'assignment', lifecycleId: 'issue', modeId: 'work' },
  instructions: 'trusted assignment instructions',
  lifecycle,
  mode: { disableTools: false, id: 'work' },
  publicationIntent: 'assignment-response',
} as GitHubNotificationTurnContract;
const implementationContract = {
  identity: { eventId: 'implementation', lifecycleId: 'issue', modeId: 'work' },
  instructions: 'trusted implementation instructions',
  lifecycle,
  mode: { disableTools: false, id: 'work' },
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
    publication: {
      publicText:
        "The requested fixture is missing. I'm going to add it and validate it to resolve the issue.",
      status: 'candidate',
    },
  };
}

function implementationResult(): GitHubNotificationModelTurnCoordinatorResult {
  return {
    dispatch: { counts: { block: 0, final: 1, tool: 2 }, queuedFinal: false },
    finalPayloadCount: 1,
    privateText: '## Implementation\n\nAdded the fixture.\n\n## Validation\n\nPassed.',
    publication: { status: 'none' },
  };
}

function questionResult(): GitHubNotificationModelTurnCoordinatorResult {
  return {
    ...candidateResult(),
    privateText:
      '## Assessment\n\nThe requested outcome is unclear.\n\n## Questions\n\nWhich fixture should be added?',
    publication: {
      publicText: 'I need to confirm which fixture you want before I can plan this safely.',
      status: 'candidate',
    },
  };
}

interface HarnessOptions {
  assignmentFailures?: number;
  assignmentResult?: GitHubNotificationModelTurnCoordinatorResult;
  initialActiveTurn?: GitHubNotificationConversationState['conversations'][string]['activeTurn'];
  implementationFailures?: number;
  publicationFailures?: number;
  verifyAssignment?(input: GitHubNotificationModelTurnCoordinatorInput): void;
  verifyImplementation?(input: GitHubNotificationModelTurnCoordinatorInput): void;
}

function harness(options: HarnessOptions = {}) {
  let state = initialState();
  if (options.initialActiveTurn) {
    state.conversations[conversationId]!.activeTurn = options.initialActiveTurn;
  }
  const counts = {
    acknowledgments: 0,
    assignmentTurns: 0,
    implementationTurns: 0,
    publications: 0,
  };
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
        const activeTurn = state.conversations[conversationId]?.activeTurn;
        assert.equal(activeTurn?.sourceId, assignmentEventId);
        if (activeTurn?.eventId === 'assignment') {
          counts.assignmentTurns += 1;
          options.verifyAssignment?.(turnInput);
          if (counts.assignmentTurns <= (options.assignmentFailures ?? 0)) {
            throw new Error('assignment turn interrupted');
          }
          return options.assignmentResult ?? candidateResult();
        }
        assert.equal(activeTurn?.eventId, 'implementation');
        assert.equal(state.conversations[conversationId]?.assignmentResponse?.status, 'published');
        assert.equal(state.conversations[conversationId]?.implementation?.status, 'pending');
        counts.implementationTurns += 1;
        options.verifyImplementation?.(turnInput);
        if (counts.implementationTurns <= (options.implementationFailures ?? 0)) {
          throw new Error('implementation turn interrupted');
        }
        return implementationResult();
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
        assert.equal(resolvedConfig, config);
        assert.equal(resolvedAgentId, agentId);
        if (identity.eventId === 'assignment') {
          assert.deepEqual(identity, assignmentContract.identity);
          return assignmentContract;
        }
        assert.deepEqual(identity, implementationContract.identity);
        return implementationContract;
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
  it('should publish the work plan before running one implementation turn', async () => {
    const scenario = harness({
      verifyAssignment(turnInput) {
        assert.equal(turnInput.contract, assignmentContract);
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
      verifyImplementation(turnInput) {
        assert.equal(turnInput.contract, implementationContract);
        assert.equal(turnInput.createIfMissing, true);
        assert.equal(turnInput.executionSurface, 'cli-one-shot');
        assert.equal(turnInput.messageId, `implementation:${assignmentEventId}`);
        assert.equal(turnInput.sourceId, assignmentEventId);
        assert.equal(turnInput.ctxPayload.Provider, githubNotificationChannelId);
        assert.match(turnInput.ctxPayload.Body ?? '', /Implementation started/u);
        assert.match(turnInput.ctxPayload.Body ?? '', /published.*`work` mode/u);
      },
    });

    await scenario.prepare();
    assert.deepEqual(scenario.counts, {
      acknowledgments: 1,
      assignmentTurns: 1,
      implementationTurns: 0,
      publications: 1,
    });
    const response = scenario.state().conversations[conversationId]?.assignmentResponse;
    assert.equal(scenario.state().conversations[conversationId]?.activeTurn, undefined);
    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'pending',
    });
    assert.equal(response?.status, 'published');
    if (response?.status !== 'published') throw new Error('missing published response');
    assert.equal(response.commentDatabaseId, 44);
    assert.match(response.publicText, /I'm going to/u);
    assert.match(response.publicTextDigest, /^[a-f0-9]{64}$/u);
    assert.match(response.target, /:publication:assignment-response:[a-f0-9]{32}$/u);

    await scenario.prepare();
    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 3,
      assignmentTurns: 1,
      implementationTurns: 1,
      publications: 1,
    });
    assert.equal(scenario.state().conversations[conversationId]?.activeTurn, undefined);
    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'completed',
    });
  });

  it('should retry a pending publication without another assignment turn', async () => {
    const scenario = harness({ publicationFailures: 1 });

    await assert.rejects(scenario.prepare(), /publication interrupted/u);
    assert.equal(
      scenario.state().conversations[conversationId]?.assignmentResponse?.status,
      'pending',
    );
    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 2,
      assignmentTurns: 1,
      implementationTurns: 1,
      publications: 2,
    });
    assert.equal(
      scenario.state().conversations[conversationId]?.assignmentResponse?.status,
      'published',
    );
  });

  it('should retain the active assignment descriptor for a model-turn retry', async () => {
    const scenario = harness({ assignmentFailures: 1 });

    await assert.rejects(scenario.prepare(), /assignment turn interrupted/u);
    assert.deepEqual(scenario.state().conversations[conversationId]?.activeTurn, {
      eventId: 'assignment',
      sourceId: assignmentEventId,
    });
    await scenario.prepare();
    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 3,
      assignmentTurns: 2,
      implementationTurns: 1,
      publications: 1,
    });
    assert.equal(scenario.state().conversations[conversationId]?.activeTurn, undefined);
  });

  it('should not replace an active comment turn with assignment work', async () => {
    const activeTurn = { eventId: 'comment' as const, sourceId: 'a'.repeat(64) };
    const scenario = harness({ initialActiveTurn: activeTurn });

    await assert.rejects(scenario.prepare(), /Another GitHub notification model turn is active/u);

    assert.deepEqual(scenario.counts, {
      acknowledgments: 1,
      assignmentTurns: 0,
      implementationTurns: 0,
      publications: 0,
    });
    assert.deepEqual(scenario.state().conversations[conversationId]?.activeTurn, activeTurn);
  });

  it('should retain the active implementation descriptor for a model-turn retry', async () => {
    const scenario = harness({ implementationFailures: 1 });

    await scenario.prepare();
    await assert.rejects(scenario.prepare(), /implementation turn interrupted/u);
    assert.deepEqual(scenario.state().conversations[conversationId]?.activeTurn, {
      eventId: 'implementation',
      sourceId: assignmentEventId,
    });
    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'pending',
    });
    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 3,
      assignmentTurns: 1,
      implementationTurns: 2,
      publications: 1,
    });
    assert.equal(scenario.state().conversations[conversationId]?.activeTurn, undefined);
    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'completed',
    });
  });

  it('should not schedule implementation for published blocking questions', async () => {
    const scenario = harness({ assignmentResult: questionResult() });

    await scenario.prepare();
    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 2,
      assignmentTurns: 1,
      implementationTurns: 0,
      publications: 1,
    });
    assert.equal(
      scenario.state().conversations[conversationId]?.assignmentResponse?.status,
      'published',
    );
    assert.equal(scenario.state().conversations[conversationId]?.implementation, undefined);
  });

  it('should checkpoint a withheld response without publication', async () => {
    const scenario = harness({
      assignmentResult: {
        ...candidateResult(),
        publication: {
          code: 'github-notification-publication-candidate-missing',
          status: 'withheld',
        },
      },
    });

    await scenario.prepare();
    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 2,
      assignmentTurns: 1,
      implementationTurns: 0,
      publications: 0,
    });
    assert.deepEqual(scenario.state().conversations[conversationId]?.assignmentResponse, {
      reasonCode: 'github-notification-publication-candidate-missing',
      status: 'withheld',
    });
    assert.equal(scenario.state().conversations[conversationId]?.implementation, undefined);
  });
});
