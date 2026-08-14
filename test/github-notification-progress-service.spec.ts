import assert from 'node:assert/strict';

import type { OpenClawPluginCommandDefinition } from 'openclaw/plugin-sdk/plugin-entry';

import registerGitHubNotificationProgressCommand from '../channels/github/lib/progress-command.ts';
import GitHubNotificationProgressService from '../channels/github/lib/progress-service.ts';
import type { GitHubNotificationMonitorState } from '../channels/github/utils/monitor-state.ts';
import {
  approvedPullRequestNotificationItem,
  notificationItemKey,
  notificationMonitorState,
  notificationPullRequestItemKey,
} from './github-notification-fixtures.ts';

const publicationId = '123e4567-e89b-42d3-a456-426614174000';
const sessionKey = 'agent:tanaabot:agent-system-github:tanaabot:direct:github:item';

function activeState(): GitHubNotificationMonitorState {
  const state = notificationMonitorState();
  const item = state.items[notificationItemKey]!;
  item.delivery = {
    ...item.delivery!,
    acknowledgment: { commentId: 91, status: 'published' },
    activation: { status: 'planned' },
    sessionKey,
    stage: 'active',
    worktreeBranch: 'agent/tanaabot/issue-7',
    worktreePath: '/workspace/.agent-system/worktrees/issue-7',
  };
  return state;
}

function activePullRequestState(): GitHubNotificationMonitorState {
  const state = activeState();
  const item = approvedPullRequestNotificationItem();
  item.delivery = {
    ...state.items[notificationItemKey]!.delivery!,
    assignmentEventId: item.assignmentEventNodeId!,
    workId: 'pull-request-8',
  };
  delete item.delivery.worktreeBranch;
  delete item.delivery.worktreePath;
  state.items = { [notificationPullRequestItemKey]: item };
  return state;
}

function leaseStore() {
  return {
    async acquire() {
      return { lease: { async release() {} }, status: 'acquired' as const };
    },
  };
}

describe('channels/github/lib/progress-service', () => {
  it('should checkpoint and publish one explicit update for the exact active session', async () => {
    let current = activeState();
    let publications = 0;
    const service = new GitHubNotificationProgressService({
      createPublicationId: () => publicationId,
      leaseStore: leaseStore(),
      publicationService: {
        async publish(input) {
          publications += 1;
          assert.equal(input.intent, 'operator-progress');
          assert.equal(input.payload.text, 'Implementation is underway and checks are passing.');
          assert.equal(
            current.items[notificationItemKey]!.delivery!.progress?.[publicationId]?.status,
            'pending',
          );
          return {
            delivery: { messageIds: ['94'], visibleReplySent: true },
            status: 'handled_visible' as const,
          };
        },
      },
      stateStore: {
        async read() {
          return structuredClone(current);
        },
        async write(state) {
          current = structuredClone(state);
        },
      },
    });

    const result = await service.publish({
      agentId: 'tanaabot',
      config: {},
      sessionKey,
      text: 'Implementation is underway and checks are passing.',
    });

    assert.deepEqual(result, { commentId: 94, status: 'published' });
    assert.equal(publications, 1);
    assert.deepEqual(current.items[notificationItemKey]!.delivery!.progress, {
      [publicationId]: { commentId: 94, status: 'published' },
    });
  });

  it('should reject unsafe text and unrelated sessions before publication', async () => {
    let current = activeState();
    let publications = 0;
    let writes = 0;
    const service = new GitHubNotificationProgressService({
      createPublicationId: () => publicationId,
      leaseStore: leaseStore(),
      publicationService: {
        async publish() {
          publications += 1;
          throw new Error('not used');
        },
      },
      stateStore: {
        async read() {
          return structuredClone(current);
        },
        async write(state) {
          writes += 1;
          current = structuredClone(state);
        },
      },
    });

    await assert.rejects(
      service.publish({
        agentId: 'tanaabot',
        config: {},
        sessionKey,
        text: 'Inspect /Users/pirog/private.txt',
      }),
      /not safe to publish/u,
    );
    await assert.rejects(
      service.publish({ agentId: 'tanaabot', config: {}, sessionKey, text: '' }),
      /not safe to publish/u,
    );
    await assert.rejects(
      service.publish({
        agentId: 'tanaabot',
        config: {},
        sessionKey: 'agent:tanaabot:main',
        text: 'Implementation is underway.',
      }),
      /could not be published/u,
    );
    assert.equal(publications, 0);
    assert.equal(writes, 0);
  });

  it('should publish explicit progress from an active pull-request session', async () => {
    let current = activePullRequestState();
    const service = new GitHubNotificationProgressService({
      createPublicationId: () => publicationId,
      leaseStore: leaseStore(),
      publicationService: {
        async publish() {
          return {
            delivery: { messageIds: ['95'], visibleReplySent: true },
            status: 'handled_visible' as const,
          };
        },
      },
      stateStore: {
        async read() {
          return structuredClone(current);
        },
        async write(state) {
          current = structuredClone(state);
        },
      },
    });

    assert.deepEqual(
      await service.publish({
        agentId: 'tanaabot',
        config: {},
        sessionKey,
        text: 'Pull request review is underway.',
      }),
      { commentId: 95, status: 'published' },
    );
    assert.deepEqual(
      current.items[notificationPullRequestItemKey]?.delivery?.progress?.[publicationId],
      { commentId: 95, status: 'published' },
    );
  });

  it('should retain a value-free failure checkpoint after terminal publication failure', async () => {
    let current = activeState();
    const service = new GitHubNotificationProgressService({
      createPublicationId: () => publicationId,
      leaseStore: leaseStore(),
      publicationService: {
        async publish() {
          throw Object.assign(new Error('provider prose'), {
            code: 'github-notification-publication-authority-revoked',
          });
        },
      },
      stateStore: {
        async read() {
          return structuredClone(current);
        },
        async write(state) {
          current = structuredClone(state);
        },
      },
    });

    await assert.rejects(
      service.publish({
        agentId: 'tanaabot',
        config: {},
        sessionKey,
        text: 'Implementation is underway.',
      }),
      /could not be published/u,
    );
    assert.deepEqual(current.items[notificationItemKey]!.delivery!.progress, {
      [publicationId]: {
        failureCode: 'github-notification-publication-authority-revoked',
        status: 'failed',
      },
    });
  });
});

describe('channels/github/lib/progress-command', () => {
  it('should require direct gateway operator scope and exact session context', async () => {
    let command: OpenClawPluginCommandDefinition | undefined;
    const calls: unknown[] = [];
    registerGitHubNotificationProgressCommand(
      {
        registerCommand(definition) {
          command = definition;
        },
      },
      {
        logger: { error() {}, info() {}, warn() {} },
        progressService: {
          async publish(input) {
            calls.push(input);
            return { commentId: 94, status: 'published' as const };
          },
        },
      },
    );

    assert.equal(command?.name, 'agent-system-progress');
    assert.deepEqual(command?.requiredScopes, ['operator.write']);
    const missingScope = await command!.handler({
      agentId: 'tanaabot',
      args: 'Implementation is underway.',
      channel: 'webchat',
      commandBody: '/agent-system-progress Implementation is underway.',
      config: {},
      isAuthorizedSender: true,
      sessionKey,
    } as never);
    assert.equal(missingScope.isError, true);
    assert.match(missingScope.text ?? '', /^## ⚠️ GitHub progress not published$/mu);
    assert.match(missingScope.text ?? '', /operator-authorization-required/u);

    const missingSession = await command!.handler({
      agentId: 'tanaabot',
      args: 'Implementation is underway.',
      channel: 'webchat',
      commandBody: '/agent-system-progress Implementation is underway.',
      config: {},
      gatewayClientScopes: ['operator.write'],
      isAuthorizedSender: true,
    } as never);
    assert.equal(missingSession.isError, true);
    assert.match(missingSession.text ?? '', /The selected progress update was not published/u);
    assert.match(missingSession.text ?? '', /session-required/u);

    const result = await command!.handler({
      agentId: 'tanaabot',
      args: 'Implementation is underway.',
      channel: 'webchat',
      commandBody: '/agent-system-progress Implementation is underway.',
      config: {},
      gatewayClientScopes: ['operator.write'],
      isAuthorizedSender: true,
      sessionKey,
    } as never);
    assert.deepEqual(result, {
      text: [
        '## 📤 GitHub progress published',
        '',
        'The selected progress update was published to GitHub.',
        '',
        '> Implementation is underway.',
      ].join('\n'),
    });
    assert.equal(calls.length, 1);
  });
});
