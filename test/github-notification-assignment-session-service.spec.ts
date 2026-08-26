import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import { githubNotificationConversationId } from '../channels/github/channel.ts';
import GitHubNotificationAssignmentSessionService from '../channels/github/conversation/assignment-session-service.ts';
import type { GitHubNotificationIssueDeliveryInput } from '../channels/github/conversation/issue-delivery-service.ts';
import {
  createGitHubNotificationConversationState,
  githubNotificationPublicTextDigest,
  type GitHubNotificationConversationState,
} from '../channels/github/conversation/conversation-state.ts';
import type {
  GitHubNotificationModelTurnCoordinatorInput,
  GitHubNotificationModelTurnCoordinatorResult,
} from '../channels/github/conversation/model-turn-coordinator.ts';
import type { GitHubNotificationTurnContract } from '../channels/github/conversation/turn-contract.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import githubNotificationGuidedMode from '../channels/github/modes/guided.ts';
import type { GitHubNotificationMode } from '../channels/github/modes/types.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import { githubWorkItemKey } from '../channels/github/provider/work-item.ts';
import { githubNotificationPublicationTarget } from '../channels/github/publication/publication.ts';
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
  async cleanupGitHub() {
    return { status: 'missing' };
  },
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
const guidedAssignmentContract = {
  identity: { eventId: 'assignment', lifecycleId: 'issue', modeId: 'guided' },
  instructions: 'trusted guided assignment instructions',
  lifecycle,
  mode: { disableTools: false, id: 'guided' },
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
const deliveryReceipt = {
  pullRequestNodeId: 'PR_delivery',
  pullRequestNumber: 45,
};
const itemContext = {
  body: 'Create assignment-planning-123-4.txt with the exact requested contents.',
  comments: [
    {
      authorLogin: 'pirog',
      body: 'Keep the assignment planning-only.',
      createdAt: '2026-08-25T12:00:00.000Z',
    },
  ],
  labels: ['feature'],
  title: 'add assignment planning fixture 123 4 Linux',
  truncated: false,
};

function initialState(modeId: 'guided' | 'work' = 'work'): GitHubNotificationConversationState {
  const state = createGitHubNotificationConversationState(agentId, workspaceDir);
  state.conversations[conversationId] = {
    baselineEstablished: false,
    itemKey: githubWorkItemKey(item.repositoryNodeId, item.number),
    lifecycleId: 'issue',
    mode: modeId,
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

function unstructuredPlanResult(): GitHubNotificationModelTurnCoordinatorResult {
  return {
    ...candidateResult(),
    privateText:
      'The user needs the missing fixture. I will add the exact file, validate it, and keep the change scoped.',
    publication: {
      publicText: "The fixture is missing. I'm going to add and validate it to resolve the issue.",
      status: 'candidate',
    },
  };
}

function guidedResult(): GitHubNotificationModelTurnCoordinatorResult {
  return {
    ...candidateResult(),
    privateText: 'The assignment context is prepared. I am waiting for your direction.',
    publication: { status: 'none' },
  };
}

interface HarnessOptions {
  assignmentFailures?: number;
  assignmentResult?: GitHubNotificationModelTurnCoordinatorResult;
  deliveryFailures?: number;
  handoffFailures?: number;
  initialActiveTurn?: GitHubNotificationConversationState['conversations'][string]['activeTurn'];
  implementationFailures?: number;
  mode?: GitHubNotificationMode;
  publicationFailures?: number;
  verifyAssignment?(input: GitHubNotificationModelTurnCoordinatorInput): void;
  verifyDelivery?(input: GitHubNotificationIssueDeliveryInput): void;
  verifyImplementation?(input: GitHubNotificationModelTurnCoordinatorInput): void;
}

function harness(options: HarnessOptions = {}) {
  const mode = options.mode ?? githubNotificationWorkMode;
  const expectedAssignmentContract =
    mode.policy.id === 'guided' ? guidedAssignmentContract : assignmentContract;
  let state = initialState(mode.policy.id === 'guided' ? 'guided' : 'work');
  let contextReads = 0;
  if (options.initialActiveTurn) {
    state.conversations[conversationId]!.activeTurn = options.initialActiveTurn;
  }
  const counts = {
    acknowledgments: 0,
    assignmentTurns: 0,
    deliveries: 0,
    handoffCheckpoints: 0,
    handoffs: 0,
    implementationTurns: 0,
    publications: 0,
  };
  const service = new GitHubNotificationAssignmentSessionService({
    acknowledgments: {
      async publish(acknowledgment) {
        counts.acknowledgments += 1;
        assert.equal(acknowledgment.item, item);
        assert.equal(acknowledgment.modeId, mode.policy.id);
      },
    },
    assignmentAuthority: {
      async open(authorityInput) {
        assert.equal(authorityInput.agentId, agentId);
        assert.equal(authorityInput.intake, item.intake);
        assert.equal(authorityInput.item, item);
        assert.equal(authorityInput.workspaceDir, workspaceDir);
        return {
          authorized: true,
          client: {
            async getItemContext(owner, name, number, itemType) {
              contextReads += 1;
              assert.deepEqual(
                [owner, name, number, itemType],
                ['tanaabased', 'example', 12, 'issue'],
              );
              return structuredClone(itemContext);
            },
          },
          configuration: {
            approvedActors: [],
            assignmentTypes: ['issue', 'pull-request'],
            intervalMinutes: 5,
          },
        };
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
    deliveries: {
      async deliver(deliveryInput) {
        counts.deliveries += 1;
        options.verifyDelivery?.(deliveryInput);
        if (counts.deliveries <= (options.deliveryFailures ?? 0)) {
          throw new Error('delivery interrupted');
        }
        return deliveryReceipt;
      },
    },
    handoffs: {
      async checkpoint(handoffInput) {
        counts.handoffCheckpoints += 1;
        assert.equal(handoffInput.agentId, agentId);
        assert.equal(handoffInput.executionSurface, input.executionSurface);
        assert.equal(handoffInput.item, item);
        assert.equal(handoffInput.lifecycle, input.lifecycle);
        assert.equal(handoffInput.pullRequest, deliveryReceipt);
        assert.equal(handoffInput.workspaceDir, workspaceDir);
        assert.equal(
          state.conversations[conversationId]?.implementation?.status,
          'delivery-pending',
        );
        state.conversations[conversationId]!.deliveryPullRequest = {
          baselineEstablished: false,
          eventRecorded: false,
          nodeId: deliveryReceipt.pullRequestNodeId,
          number: deliveryReceipt.pullRequestNumber,
          status: 'open',
        };
      },
      async reconcile(handoffInput) {
        counts.handoffs += 1;
        assert.equal(handoffInput.agentId, agentId);
        assert.equal(handoffInput.executionSurface, input.executionSurface);
        assert.equal(handoffInput.item, item);
        assert.equal(handoffInput.lifecycle, input.lifecycle);
        assert.equal(handoffInput.workspaceDir, workspaceDir);
        assert.equal(state.conversations[conversationId]?.implementation?.status, 'completed');
        if (counts.handoffs <= (options.handoffFailures ?? 0)) {
          throw new Error('handoff interrupted');
        }
        const publicText = 'Pull request linked.';
        const source = state.conversations[conversationId]!.deliveryPullRequest!;
        source.baselineEstablished = true;
        source.eventRecorded = true;
        source.handoff = {
          commentDatabaseId: 46,
          commentNodeId: 'IC_handoff',
          publicText,
          publicTextDigest: githubNotificationPublicTextDigest(publicText),
          status: 'published',
          target: githubNotificationPublicationTarget({
            conversationId,
            intent: 'pull-request-handoff',
            publicationId: deliveryReceipt.pullRequestNodeId,
          }),
        };
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
          assert.deepEqual(identity, expectedAssignmentContract.identity);
          return expectedAssignmentContract;
        }
        assert.deepEqual(identity, implementationContract.identity);
        return implementationContract;
      },
    },
  });
  return {
    counts,
    contextReads: () => contextReads,
    prepare: () => service.prepare({ ...input, mode }),
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
        assert.match(turnInput.ctxPayload.Body ?? '', /add assignment planning fixture/u);
        assert.deepEqual(turnInput.ctxPayload.UntrustedStructuredContext, [
          {
            label: 'GitHub lifecycle context',
            payload: {
              item: {
                lifecycleId: 'issue',
                number: 12,
                repositoryName: 'example',
                repositoryOwner: 'tanaabased',
              },
              issue: itemContext,
              worktree: { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
            },
            source: 'agent-system',
            type: 'github_lifecycle_context',
          },
        ]);
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
        assert.match(turnInput.ctxPayload.Body ?? '', /one local commit/u);
        assert.deepEqual(turnInput.ctxPayload.UntrustedStructuredContext?.[0], {
          label: 'GitHub lifecycle context',
          payload: {
            item: {
              lifecycleId: 'issue',
              number: 12,
              repositoryName: 'example',
              repositoryOwner: 'tanaabased',
            },
            issue: itemContext,
            worktree: { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
          },
          source: 'agent-system',
          type: 'github_lifecycle_context',
        });
      },
      verifyDelivery(deliveryInput) {
        assert.equal(deliveryInput.agentId, agentId);
        assert.equal(deliveryInput.item, item);
        assert.equal(deliveryInput.workspaceDir, workspaceDir);
        assert.equal(deliveryInput.worktree, input.worktree);
      },
    });

    await scenario.prepare();
    assert.deepEqual(scenario.counts, {
      acknowledgments: 1,
      assignmentTurns: 1,
      deliveries: 0,
      handoffCheckpoints: 0,
      handoffs: 0,
      implementationTurns: 0,
      publications: 1,
    });
    assert.equal(scenario.contextReads(), 1);
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
      deliveries: 1,
      handoffCheckpoints: 1,
      handoffs: 1,
      implementationTurns: 1,
      publications: 1,
    });
    assert.equal(scenario.contextReads(), 2);
    assert.equal(scenario.state().conversations[conversationId]?.activeTurn, undefined);
    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'completed',
    });
  });

  it('should prepare guided mode without scheduling automatic implementation', async () => {
    const scenario = harness({
      assignmentResult: guidedResult(),
      mode: githubNotificationGuidedMode,
      verifyAssignment(turnInput) {
        assert.equal(turnInput.contract, guidedAssignmentContract);
        assert.match(
          turnInput.ctxPayload.Body ?? '',
          /workspace is prepared; wait for operator direction in `guided` mode/u,
        );
      },
    });

    await scenario.prepare();
    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 2,
      assignmentTurns: 1,
      deliveries: 0,
      handoffCheckpoints: 0,
      handoffs: 0,
      implementationTurns: 0,
      publications: 0,
    });
    assert.deepEqual(scenario.state().conversations[conversationId]?.assignmentResponse, {
      reasonCode: 'github-notification-guided-waiting',
      status: 'withheld',
    });
    assert.equal(scenario.state().conversations[conversationId]?.implementation, undefined);
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
      deliveries: 1,
      handoffCheckpoints: 1,
      handoffs: 1,
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
      deliveries: 1,
      handoffCheckpoints: 1,
      handoffs: 1,
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
      deliveries: 0,
      handoffCheckpoints: 0,
      handoffs: 0,
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
      deliveries: 1,
      handoffCheckpoints: 1,
      handoffs: 1,
      implementationTurns: 2,
      publications: 1,
    });
    assert.equal(scenario.state().conversations[conversationId]?.activeTurn, undefined);
    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'completed',
    });
  });

  it('should retry delivery without another implementation model turn', async () => {
    const scenario = harness({ deliveryFailures: 1 });

    await scenario.prepare();
    await assert.rejects(scenario.prepare(), /delivery interrupted/u);
    assert.equal(scenario.state().conversations[conversationId]?.activeTurn, undefined);
    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'delivery-pending',
    });
    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 3,
      assignmentTurns: 1,
      deliveries: 2,
      handoffCheckpoints: 1,
      handoffs: 1,
      implementationTurns: 1,
      publications: 1,
    });
    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'completed',
    });
  });

  it('should retain completed delivery while retrying pull request handoff', async () => {
    const scenario = harness({ handoffFailures: 1 });

    await scenario.prepare();
    await assert.rejects(scenario.prepare(), /handoff interrupted/u);

    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'completed',
    });
    assert.deepEqual(scenario.counts, {
      acknowledgments: 2,
      assignmentTurns: 1,
      deliveries: 1,
      handoffCheckpoints: 1,
      handoffs: 1,
      implementationTurns: 1,
      publications: 1,
    });

    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 3,
      assignmentTurns: 1,
      deliveries: 1,
      handoffCheckpoints: 1,
      handoffs: 2,
      implementationTurns: 1,
      publications: 1,
    });
    assert.equal(
      scenario.state().conversations[conversationId]?.deliveryPullRequest?.handoff?.status,
      'published',
    );
  });

  it('should schedule implementation without parsing model-authored report formatting', async () => {
    const scenario = harness({ assignmentResult: unstructuredPlanResult() });

    await scenario.prepare();
    await scenario.prepare();

    assert.deepEqual(scenario.counts, {
      acknowledgments: 2,
      assignmentTurns: 1,
      deliveries: 1,
      handoffCheckpoints: 1,
      handoffs: 1,
      implementationTurns: 1,
      publications: 1,
    });
    assert.equal(
      scenario.state().conversations[conversationId]?.assignmentResponse?.status,
      'published',
    );
    assert.deepEqual(scenario.state().conversations[conversationId]?.implementation, {
      status: 'completed',
    });
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
      deliveries: 0,
      handoffCheckpoints: 0,
      handoffs: 0,
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
