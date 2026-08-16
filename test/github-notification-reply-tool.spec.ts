import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from 'openclaw/plugin-sdk/plugin-entry';

import createGitHubNotificationReplyTool, {
  githubNotificationReplyToolName,
} from '../channels/github/reply-tool.ts';
import GitHubNotificationReplyCandidateStore from '../channels/github/lib/reply-candidate-store.ts';
import { githubNotificationChannelId } from '../channels/github/utils/routing.ts';

describe('channels/github/reply-tool', () => {
  it('should expose one typed staging tool only in the github notification channel', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-reply-tool-'));
    const rootDir = join(temporaryDirectory, 'state');
    const parentCandidates = new GitHubNotificationReplyCandidateStore({ rootDir });
    const toolCandidates = new GitHubNotificationReplyCandidateStore({ rootDir });
    const diagnostics: string[] = [];
    const turn = await parentCandidates.begin({
      agentId: 'tanaabot',
      conversationId: 'github:issue:repository:12',
      revisionId: 'revision-1',
    });
    let factory: OpenClawPluginToolFactory | undefined;
    const registered = createGitHubNotificationReplyTool(toolCandidates, {
      debug(message) {
        diagnostics.push(message);
      },
    });
    try {
      registered.registerTools(
        {
          registerTool(next) {
            factory = next as OpenClawPluginToolFactory;
          },
        },
        {
          async executeSemantic(
            definition: {
              execute(
                input: { body: string },
                configuration: unknown,
                scope: {
                  agentId: string;
                  resolveEnvironment(name: string): string | undefined;
                  source: 'tool';
                  toolContext?: OpenClawPluginToolContext;
                  workspaceDir: string;
                },
              ): Promise<unknown>;
            },
            input: { body: string },
            scope: { toolContext?: OpenClawPluginToolContext },
          ) {
            const output = await definition.execute(
              input,
              {},
              {
                agentId: 'tanaabot',
                resolveEnvironment() {
                  return undefined;
                },
                source: 'tool',
                ...(scope.toolContext === undefined ? {} : { toolContext: scope.toolContext }),
                workspaceDir: '/workspace',
              },
            );
            return {
              auditId: 'audit-1',
              kind: 'semantic',
              operation: {
                action: 'stage-github-reply',
                risk: 'write',
                summary: 'Stage reply.',
              },
              output,
            };
          },
        } as never,
      );

      assert.ok(factory);
      assert.equal(
        factory({ agentId: 'tanaabot', messageChannel: 'imessage', sessionKey: 'session-1' }),
        null,
      );
      assert.equal(
        diagnostics.at(-1),
        'github-notifications: reply tool context code=github-notification-reply-tool-context agent-id-present=true message-channel=imessage delivery-channel=unset session-key-present=true',
      );
      assert.equal(factory({ messageChannel: githubNotificationChannelId }), null);
      const tool = factory({
        agentId: 'tanaabot',
        messageChannel: githubNotificationChannelId,
        sessionKey: 'sandbox-session-that-does-not-match-the-lifecycle-route',
      });
      assert.ok(tool && !Array.isArray(tool));
      assert.equal(tool.name, githubNotificationReplyToolName);
      const result = await tool.execute('call-1', { body: ' ready ' });
      assert.deepEqual(result.details, {
        auditId: 'audit-1',
        output: { body: 'ready', kind: 'github-reply-candidate', version: 1 },
      });
      assert.deepEqual(
        await parentCandidates.finish({
          agentId: 'tanaabot',
          conversationId: 'github:issue:repository:12',
          revisionId: 'revision-1',
          turnId: turn,
        }),
        ['ready'],
      );
      assert.equal(result.content[0]?.type, 'text');
      if (result.content[0]?.type === 'text') {
        assert.match(result.content[0].text, /github-reply-candidate/u);
      }
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });
});
