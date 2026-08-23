import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import GitHubNotificationAssignmentSessionService, {
  type GitHubNotificationAssignmentSessionServiceDependencies,
} from '../channels/github/conversation/assignment-session-service.ts';
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

describe('channels/github/conversation/assignment-session-service', () => {
  it('should idempotently prepare one assignment session without model dispatch', async () => {
    const item = notificationMonitorState().items[notificationItemKey]!;
    const sequence: string[] = [];
    let acknowledgments = 0;
    let records = 0;
    let recordedSessionKey: string | undefined;
    const recordInboundSession: GitHubNotificationAssignmentSessionServiceDependencies['recordInboundSession'] =
      async (input) => {
        sequence.push('record');
        records += 1;
        recordedSessionKey = input.sessionKey;
        assert.equal(input.createIfMissing, true);
        assert.equal(input.ctx.Provider, githubNotificationChannelId);
        assert.equal(
          input.ctx.Body,
          [
            '## 📥 Issue assigned',
            '',
            '[@pirog](https://github.com/pirog) assigned you to [tanaabased/example#12](https://github.com/tanaabased/example/issues/12). Please begin working on it in `work` mode.',
          ].join('\n'),
        );
        assert.equal(
          JSON.stringify(input.ctx.UntrustedStructuredContext),
          JSON.stringify([
            {
              item: {
                lifecycleId: 'issue',
                number: 12,
                repositoryName: 'example',
                repositoryOwner: 'tanaabased',
              },
              worktree: { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
            },
          ]),
        );
        input.trackSessionMetaTask?.(
          Promise.resolve({ sessionId: 'session-1', sessionKey: input.sessionKey }),
        );
      };
    const service = new GitHubNotificationAssignmentSessionService({
      acknowledgments: {
        async publish(input) {
          sequence.push('acknowledgment');
          acknowledgments += 1;
          assert.equal(input.agentId, agentId);
          assert.equal(input.item, item);
          assert.equal(input.modeId, 'work');
          assert.equal(input.workspaceDir, workspaceDir);
        },
      },
      logger: { error() {}, info() {}, warn() {} },
      readConfig: async () => config,
      recordInboundSession,
    });
    const lifecycle = new GitHubIssueLifecycle({
      async inspectGitHub() {
        return undefined;
      },
      async prepareGitHub() {
        throw new Error('not used');
      },
    });
    const input = {
      agentId,
      item,
      lifecycle,
      mode: githubNotificationWorkMode,
      workspaceDir,
      worktree: { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
    };

    await service.prepare(input);
    await service.prepare(input);

    assert.equal(records, 2);
    assert.equal(acknowledgments, 2);
    assert.deepEqual(sequence, ['record', 'acknowledgment', 'record', 'acknowledgment']);
    assert.match(recordedSessionKey ?? '', /^agent:tanaabot:agent-system-github:/u);
  });
});
