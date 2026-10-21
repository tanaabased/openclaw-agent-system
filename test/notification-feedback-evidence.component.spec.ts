import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('examples/openclaw-pr retained feedback evidence', () => {
  it('should permit only terminal acknowledgement on the earlier feedback event', async () => {
    const source = await readFile('examples/openclaw-pr/README.md', 'utf8');
    const code = [...source.matchAll(/jq -e --slurp '([^']+)'/gu)]
      .map((match) => match[1]!)
      .find((text) => text.includes('initial-feedback-receipts-changed'));
    assert.ok(code);
    const before = {
      id: 'initial',
      source: 'exact source',
      revision: 'exact revision',
      phase: 'published',
      receipt: { nodeId: 'reply' },
      result: { privateText: 'Private answer.', publicText: 'Public answer.' },
      work: { head: 'original head' },
      turn: {
        runId: 'initial-run',
        message: 'exact input',
        status: 'consumed',
        consumedByEventId: 'input',
      },
    };
    const after = {
      ...before,
      turn: {
        ...before.turn,
        status: 'completed',
        replyEventId: 'terminal',
        executionModel: 'fixture/model',
      },
    };
    const execute = (event: unknown) =>
      spawnSync('jq', ['-e', '--slurp', code], {
        input: [{ feedback: { events: [before] } }, { feedback: { events: [event] } }]
          .map((v) => JSON.stringify(v))
          .join('\n'),
        encoding: 'utf8',
      });
    const valid = execute(after);
    assert.equal(valid.status, 0, valid.stderr);
    for (const changed of [
      { ...after, source: 'edited source' },
      { ...after, revision: 'different revision' },
      { ...after, receipt: { nodeId: 'different reply' } },
      { ...after, result: { ...after.result, publicText: 'changed answer' } },
      { ...after, work: { head: 'changed head' } },
      { ...after, turn: { ...after.turn, runId: 'replacement-run' } },
      { ...after, turn: { ...after.turn, consumedByEventId: 'different input' } },
      { ...after, turn: { ...after.turn, failed: true } },
      { ...after, turn: { ...after.turn, replyEventId: null } },
      before,
    ])
      assert.notEqual(execute(changed).status, 0);
  });
});

for (const [scenario, itemType] of [
  ['openclaw-issue', 'issue'],
  ['openclaw-pr', 'pull-request'],
  ['openclaw-lifecycle', 'issue'],
]) {
  describe(`examples/${scenario} feedback evidence`, () => {
    it('should inspect only its requested run while rejecting real duplicate responses', async () => {
      const source = await readFile(`examples/${scenario}/README.md`, 'utf8');
      const code = [...source.matchAll(/node --input-type=module -e '([^']+)'/gu)]
        .map((match) => match[1]!)
        .find((text) => text.includes('const record=read("feedback")'));
      assert.ok(code);
      const root = await mkdtemp(join(tmpdir(), 'feedback-evidence-'));
      const answer = {
        role: 'assistant',
        __openclaw: { runId: 'current' },
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
        const summaries =
          itemType === 'issue'
            ? ['summary', ...(scenario === 'openclaw-lifecycle' ? ['refreshed-summary'] : [])]
            : [];
        await write('feedback', {
          assessmentSummaries: summaries.map((nodeId) => ({ receipt: { nodeId } })),
          feedback: {
            events: [
              ...(scenario === 'openclaw-pr'
                ? [{ itemType: 'issue', turn: { runId: 'earlier' } }]
                : []),
              {
                itemType,
                source: JSON.stringify({ nodeId: 'source' }),
                receipt: { nodeId: 'reply' },
                turn: { runId: 'current' },
                result: { privateText: 'Private explanation.', publicText: 'Public answer.' },
              },
            ],
          },
        });
        await write('feedback-source', { node_id: 'source' });
        const replies = [
          ...summaries.map((node_id) => ({
            node_id,
            user: { login: 'tanaabot' },
            body: 'Proposed plan.',
          })),
          {
            node_id: 'source',
            user: { login: 'emoriwan' },
            body: 'Question',
          },
          {
            node_id: 'reply',
            html_url: 'https://github.com/owner/repo/issues/3#issuecomment-99',
            user: { login: 'tanaabot' },
            body: 'Public answer.',
          },
        ];
        await write('feedback-replies', replies);
        const prior = { ...answer, __openclaw: { runId: 'earlier' } };
        await write('feedback-history', {
          requestedRunId: 'current',
          messages: [prior, prior, prior, answer],
        });
        const valid = execute();
        assert.equal(valid.status, 0, valid.stderr);
        await write('feedback-replies', [
          ...replies,
          { node_id: 'unexpected-reply', user: { login: 'tanaabot' }, body: 'Public answer.' },
        ]);
        assert.notEqual(execute().status, 0);
        await write('feedback-replies', replies);
        await write('feedback-history', { requestedRunId: 'current', messages: [answer, answer] });
        assert.notEqual(execute().status, 0);
        await write('feedback-history', { requestedRunId: 'wrong-run', messages: [answer] });
        assert.notEqual(execute().status, 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
}
