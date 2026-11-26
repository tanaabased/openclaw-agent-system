import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimBody } from '../channels/github/provider/assignment-claim.ts';
import { githubNotificationPublicationComment } from '../channels/github/publication/publication-contract.ts';

for (const scenario of ['openclaw-pr-journey', 'openclaw-pr-discovery']) {
  describe(`examples/${scenario} retained feedback evidence`, () => {
    it('should permit only verified consumption on the earlier feedback event', async () => {
      const source = await readFile(`examples/${scenario}/README.md`, 'utf8');
      const code = [...source.matchAll(/jq -e --slurp '([^']+)'/gu)]
        .map((match) => match[1]!)
        .find((text) => text.includes('initial-feedback-receipts-changed'));
      assert.ok(code);
      const before = {
        id: 'initial',
        source: 'exact source',
        revision: 'exact revision',
        phase: 'running',
        turn: {
          runId: 'initial-run',
          message: 'exact input',
          status: 'consumed',
          consumedByEventId: 'input',
        },
      };
      const after = {
        ...before,
        phase: 'delivered',
      };
      const execute = (event: unknown, initial: unknown = before) =>
        spawnSync('jq', ['-e', '--slurp', code], {
          input: [{ feedback: { events: [initial] } }, { feedback: { events: [event] } }]
            .map((v) => JSON.stringify(v))
            .join('\n'),
          encoding: 'utf8',
        });
      const valid = execute(after);
      assert.equal(valid.status, 0, valid.stderr);
      assert.equal(execute(after, after).status, 0);
      assert.equal(execute({ ...after, intakeReportedAt: 1 }).status, 0);
      assert.equal(
        execute(after, {
          ...before,
          turn: { runId: 'initial-run', message: 'exact input', status: 'accepted' },
        }).status,
        0,
      );
      for (const changed of [
        { ...after, source: 'edited source' },
        { ...after, revision: 'different revision' },
        { ...after, turn: { ...after.turn, runId: 'replacement-run' } },
        { ...after, turn: { ...after.turn, consumedByEventId: 'different input' } },
        { ...after, turn: { ...after.turn, failed: true } },
        { ...after, turn: { ...after.turn, cancelled: true } },
        { ...after, turn: { ...after.turn, consumedByEventId: null } },
        { ...after, turn: { ...after.turn, status: 'accepted' } },
        before,
      ])
        assert.notEqual(execute(changed).status, 0);
    });
  });
}

for (const [scenario, itemType] of [
  ['openclaw-issue-assignment-policy', 'issue'],
  ['openclaw-pr-journey', 'pull-request'],
  ['openclaw-pr-discovery', 'pull-request'],
]) {
  describe(`examples/${scenario} feedback evidence`, () => {
    it('should inspect only its requested run while rejecting real duplicate responses', async () => {
      const source = await readFile(`examples/${scenario}/README.md`, 'utf8');
      const code = [...source.matchAll(/node --input-type=module -e '([^']+)'/gu)]
        .map((match) => match[1]!)
        .find((text) => text.includes('const record=read("feedback")'));
      assert.ok(code);
      const root = await mkdtemp(join(tmpdir(), 'feedback-evidence-'));
      const runId =
        scenario === 'openclaw-pr-discovery' ? 'notification-feedback-resume' : 'current';
      const replyBody = githubNotificationPublicationComment(
        'Public answer.',
        `<!-- agent-system-github-publication:github-reply:${'a'.repeat(32)} -->`,
      );
      const summaryBody = githubNotificationPublicationComment(
        'Proposed plan.',
        `<!-- agent-system-github-publication:status-update:${'b'.repeat(32)} -->`,
      );
      const inline = scenario === 'openclaw-pr-journey';
      const providerSource = {
        ...(inline ? { id: 31 } : {}),
        node_id: 'source',
        body: '@tanaabot explain the retained plan.',
        html_url: 'https://github.com/owner/repo/issues/3#issuecomment-42',
        user: { login: 'emoriwan' },
      };
      const incoming = {
        role: 'user',
        content:
          '[@tanaabot](https://github.com/tanaabot) explain the retained plan.\n\n&nbsp;  \n*[Comment ↗](https://github.com/owner/repo/issues/3#issuecomment-42) from [@emoriwan](https://github.com/emoriwan)*',
      };
      const answer = {
        role: 'assistant',
        __openclaw: { runId },
        stopReason: 'stop',
        content:
          'Private explanation. Public answer.\n> *[Reply ↗](https://github.com/owner/repo/issues/3#issuecomment-99) from [@tanaabot](https://github.com/tanaabot)*',
      };
      const write = (name: string, value: unknown) =>
        writeFile(join(root, `notification-${name}.json`), JSON.stringify(value));
      const execute = () =>
        spawnSync(process.execPath, ['--input-type=module', '-e', code], {
          env: { ...process.env, TMPDIR: root },
          encoding: 'utf8',
        });
      try {
        const summaries = itemType === 'issue' ? ['summary'] : [];
        await write('feedback', {
          feedback: {
            events: [
              ...(itemType === 'pull-request'
                ? [{ itemType: 'issue', turn: { runId: 'earlier' } }]
                : []),
              {
                id: 'event',
                itemType,
                source: JSON.stringify({ nodeId: 'source', body: providerSource.body }),
                turn: { runId: 'current' },
              },
            ],
          },
        });
        await write('reply-drafts', [
          ...summaries.map((nodeId) => ({ update: { facts: [] }, receipt: { nodeId } })),
          {
            feedback: { eventId: 'event' },
            privateText: 'Private explanation.',
            publicText: 'Public answer.',
            receipt: { nodeId: 'reply' },
          },
        ]);
        await write('feedback-source', providerSource);
        const replies = [
          ...summaries.map((node_id) => ({
            node_id,
            user: { login: 'tanaabot' },
            body: summaryBody,
          })),
          {
            ...(inline ? { id: 42, pull_request_review_id: 31 } : {}),
            node_id: 'source',
            user: { login: 'emoriwan' },
            body: 'Question',
          },
          {
            ...(inline ? { in_reply_to_id: 42 } : {}),
            node_id: 'reply',
            html_url: 'https://github.com/owner/repo/issues/3#issuecomment-99',
            user: { login: 'tanaabot' },
            body: replyBody,
          },
          {
            node_id: 'other-instance-claim',
            user: { login: 'tanaabot' },
            body: claimBody(
              {
                instanceId: '11111111-1111-4111-8111-111111111111',
                assignmentEventId: 'assignment',
              },
              'other-instance',
            ),
          },
        ];
        await write('feedback-replies', replies);
        const prior = { ...answer, __openclaw: { runId: 'earlier' } };
        await write('feedback-history', {
          requestedRunId: runId,
          messages: [incoming, prior, prior, prior, answer],
        });
        const valid = execute();
        assert.equal(valid.status, 0, valid.stderr);
        await write('feedback-replies', [
          ...replies,
          { node_id: 'unexpected-reply', user: { login: 'tanaabot' }, body: replyBody },
        ]);
        assert.notEqual(execute().status, 0);
        await write('feedback-replies', replies);
        await write('feedback-history', {
          requestedRunId: runId,
          messages: [incoming, answer, answer],
        });
        assert.notEqual(execute().status, 0);
        await write('feedback-history', {
          requestedRunId: 'wrong-run',
          messages: [incoming, answer],
        });
        assert.notEqual(execute().status, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
