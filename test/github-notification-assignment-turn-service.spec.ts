import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import GitHubNotificationAssignmentTurnService from '../channels/github/conversation/assignment-turn-service.ts';
import type { GitHubNotificationTurnContract } from '../channels/github/conversation/turn-contract.ts';
import GitHubIssueLifecycle from '../channels/github/lifecycles/issue.ts';
import githubNotificationWorkMode from '../channels/github/modes/work.ts';
import { githubNotificationChannelId } from '../channels/github/routing/routing.ts';
import { notificationItemKey, notificationMonitorState } from './github-notification-fixtures.ts';

const agentId = 'tanaabot';
const workspaceDir = '/workspace';
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

describe('channels/github/conversation/assignment-turn-service', () => {
  it('should dispatch bounded issue and worktree context through the assignment tuple', async () => {
    const item = notificationMonitorState().items[notificationItemKey]!;
    const sourceId = item.intake!.assignmentEventId;
    const lifecycle = new GitHubIssueLifecycle({
      async inspectGitHub() {
        return undefined;
      },
      async prepareGitHub() {
        throw new Error('not used');
      },
    });
    const identity = { eventId: 'assignment', lifecycleId: 'issue', modeId: 'work' } as const;
    const contract = {
      identity,
      instructions: 'trusted assignment instructions',
      lifecycle,
      mode: { disableTools: false, id: 'work' },
      publicationIntent: 'assignment-response',
    } as GitHubNotificationTurnContract;
    let coordinated:
      | Parameters<
          ConstructorParameters<
            typeof GitHubNotificationAssignmentTurnService
          >[0]['coordinator']['run']
        >[0]
      | undefined;
    const service = new GitHubNotificationAssignmentTurnService({
      coordinator: {
        async run(input) {
          coordinated = input;
          return {
            dispatch: { counts: { block: 0, final: 1, tool: 1 }, queuedFinal: false },
            finalPayloadCount: 1,
            privateText:
              '## Assessment\n\nThe user needs the form to save.\n\n## Plan\n\nUpdate and test the save path.',
            publication: {
              publicText: 'I found the failing save path and have a focused plan.',
              status: 'candidate',
            },
          };
        },
      },
      logger: { error() {}, info() {}, warn() {} },
      readConfig: async () => config,
      turnContracts: {
        resolve(resolvedIdentity) {
          assert.deepEqual(resolvedIdentity, identity);
          return contract;
        },
      },
    });

    const result = await service.respond({
      agentId,
      executionSurface: 'gateway',
      item,
      itemContext: {
        body: 'Saving currently returns an error instead of persisting the update.',
        comments: [
          {
            authorLogin: 'pirog',
            body: 'This happens for existing records.',
            createdAt: '2026-08-23T12:00:00.000Z',
          },
        ],
        labels: ['bug'],
        title: 'Save the updated form',
        truncated: false,
      },
      lifecycle,
      mode: githubNotificationWorkMode,
      sourceId,
      workspaceDir,
      worktree: { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
    });

    assert.equal(result.publication.status, 'candidate');
    assert.equal(coordinated?.createIfMissing, true);
    assert.equal(coordinated?.messageId, `assignment:${sourceId}`);
    assert.equal(coordinated?.sourceId, sourceId);
    assert.equal(
      coordinated?.ctxPayload.Body,
      [
        '## 📥 Issue assigned',
        '',
        '- **Assigned by:** [@pirog](https://github.com/pirog)',
        '- **Issue:** [tanaabased/example#12](https://github.com/tanaabased/example/issues/12)',
        '- **Mode:** Work',
      ].join('\n'),
    );
    assert.deepEqual(coordinated?.ctxPayload.UntrustedStructuredContext, [
      {
        currentItem: {
          body: 'Saving currently returns an error instead of persisting the update.',
          comments: [
            {
              authorLogin: 'pirog',
              body: 'This happens for existing records.',
              createdAt: '2026-08-23T12:00:00.000Z',
            },
          ],
          labels: ['bug'],
          title: 'Save the updated form',
          truncated: false,
        },
        item: {
          lifecycleId: 'issue',
          number: 12,
          repositoryName: 'example',
          repositoryOwner: 'tanaabased',
        },
        worktree: { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
      },
    ]);
  });
});
