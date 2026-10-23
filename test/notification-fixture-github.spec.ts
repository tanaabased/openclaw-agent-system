import assert from 'node:assert/strict';

import type { AgentSystemCliResult } from '../api/types.ts';
import notificationFixtureGitHub from '../scripts/notification-fixture-github.ts';

const reply = (value: unknown): AgentSystemCliResult => ({
  exitCode: 0,
  stdout: JSON.stringify(value),
  stderr: '',
  timedOut: false,
  truncated: false,
});
const lost = { ...reply(null), exitCode: 1, stdout: '', stderr: 'unexpected end of JSON input' };
const noWait = async () => undefined;
const issue = { number: 42, assignees: [{ login: 'tanaabot' }] };
const comment = (body: string) => ({
  body,
  id: 123,
  node_id: 'IC_123',
  user: { login: 'emoriwan' },
});

describe('notification github fixtures', () => {
  it('should retain native assignment success without additional reads', async () => {
    const calls: string[][] = [];
    assert.deepEqual(
      await notificationFixtureGitHub(
        { action: 'assign', number: 42 },
        async (argv) => {
          calls.push(argv);
          return reply(issue);
        },
        noWait,
      ),
      issue,
    );
    assert.equal(calls.length, 1);
    assert.ok(calls[0]!.includes('assignees[]=tanaabot'));
  });

  it('should recover a lost assignment response from fresh issue state without repeating the post', async () => {
    const calls: string[][] = [];
    const result = await notificationFixtureGitHub(
      { action: 'assign', number: 42 },
      async (argv) => {
        calls.push(argv);
        return calls.length === 1 ? lost : reply(issue);
      },
      noWait,
    );
    assert.deepEqual(result, issue);
    assert.equal(calls.filter((argv) => argv.includes('POST')).length, 1);
    assert.equal(calls.length, 2);
  });

  it('should reconcile a lost comment response across pages using the exact author and marker', async () => {
    const calls: string[][] = [];
    let body = '';
    const result = await notificationFixtureGitHub(
      { action: 'comment', number: 42, body: '@tanaabot explain the plan', run: '123-1' },
      async (argv) => {
        calls.push(argv);
        if (argv.includes('POST')) {
          body = argv.at(-1)!.slice(5);
          return lost;
        }
        return reply([[comment('unrelated')], [comment(body)]]);
      },
      noWait,
    );
    assert.deepEqual(result, comment(body));
    assert.match(body, /<!-- fixture:123-1:[a-f0-9]{64} -->/u);
    assert.equal(calls.filter((argv) => argv.includes('POST')).length, 1);
    assert.ok(calls[1]!.includes('--paginate'));
  });

  it('should reject ambiguous edited or foreign-author marked comments without replay', async () => {
    for (const mode of ['duplicate', 'edited', 'foreign']) {
      let writes = 0;
      let body = '';
      await assert.rejects(
        notificationFixtureGitHub(
          { action: 'comment', number: 42, body: 'test', run: '123-1' },
          async (argv) => {
            if (argv.includes('POST')) {
              writes++;
              body = argv.at(-1)!.slice(5);
              return lost;
            }
            const found = comment(body);
            if (mode === 'edited') found.body = `changed ${body}`;
            if (mode === 'foreign') found.user.login = 'other';
            return reply([mode === 'duplicate' ? [found, found] : [found]]);
          },
          noWait,
        ),
        /ambiguous or altered/u,
      );
      assert.equal(writes, 1);
    }
  });

  it('should fail unresolved writes after bounded readback without posting again', async () => {
    for (const action of ['assign', 'comment'] as const) {
      let writes = 0;
      let reads = 0;
      await assert.rejects(
        notificationFixtureGitHub(
          { action, number: 42, body: 'test', run: '123-1' },
          async (argv) => {
            if (argv.includes('POST')) {
              writes++;
              return lost;
            }
            reads++;
            return reply(action === 'assign' ? { ...issue, assignees: [] } : [[]]);
          },
          noWait,
        ),
        /outcome unresolved; POST not repeated/u,
      );
      assert.equal(writes, 1);
      assert.equal(reads, 3);
    }
  });

  it('should stop at an authoritative denial or failed reconciliation read', async () => {
    for (const status of [401, 403, 429]) {
      let calls = 0;
      await assert.rejects(
        notificationFixtureGitHub(
          { action: 'assign', number: 42 },
          async () => {
            calls++;
            return { ...lost, stderr: `gh: denied (HTTP ${status})` };
          },
          noWait,
        ),
        /denied/u,
      );
      assert.equal(calls, 1);
    }
    let calls = 0;
    await assert.rejects(
      notificationFixtureGitHub(
        { action: 'assign', number: 42 },
        async () => {
          calls++;
          return calls === 1 ? lost : { ...lost, stderr: 'gh: denied (HTTP 403)' };
        },
        noWait,
      ),
      /reconciliation read failed/u,
    );
    assert.equal(calls, 2);
  });

  it('should retry read-only pr discovery on the observed graphql internal error', async () => {
    let calls = 0;
    const result = await notificationFixtureGitHub(
      { action: 'pulls', branch: 'fixture-branch' },
      async (argv) => {
        assert.equal(argv[0], 'pr');
        assert.equal(argv[1], 'list');
        return ++calls === 1
          ? { ...lost, stderr: 'GraphQL: Something went wrong while executing your query' }
          : reply([{ number: 51 }]);
      },
      noWait,
    );
    assert.deepEqual(result, [{ number: 51 }]);
    assert.equal(calls, 2);
  });
});
