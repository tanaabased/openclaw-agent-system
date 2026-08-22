import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import GitHubNotificationAssignmentSessionService, {
  type GitHubNotificationAssignmentSessionServiceDependencies,
} from '../channels/github/conversation/assignment-session-service.ts';
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
    let records = 0;
    let recordedSessionKey: string | undefined;
    const recordInboundSession: GitHubNotificationAssignmentSessionServiceDependencies['recordInboundSession'] =
      async (input) => {
        records += 1;
        recordedSessionKey = input.sessionKey;
        assert.equal(input.createIfMissing, true);
        assert.equal(input.ctx.Provider, githubNotificationChannelId);
        assert.match(String(input.ctx.Body), /Issue assignment received/u);
        assert.match(String(input.ctx.Body), /tanaabased\/example#12/u);
        input.trackSessionMetaTask?.(
          Promise.resolve({ sessionId: 'session-1', sessionKey: input.sessionKey }),
        );
      };
    const service = new GitHubNotificationAssignmentSessionService({
      logger: { error() {}, info() {}, warn() {} },
      readConfig: async () => config,
      recordInboundSession,
    });
    const input = {
      agentId,
      item,
      workspaceDir,
      worktree: { branch: 'issue-12', path: '/workspace/worktrees/issue-12' },
    };

    await service.prepare(input);
    await service.prepare(input);

    assert.equal(records, 2);
    assert.match(recordedSessionKey ?? '', /^agent:tanaabot:agent-system-github:/u);
  });
});
