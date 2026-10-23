import assert from 'node:assert/strict';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';

function response(value: unknown, status = 200, headers = 'etag: "v1"') {
  return {
    exitCode: status === 304 || status >= 400 ? 1 : 0,
    timedOut: false,
    truncated: false,
    stderr: '',
    stdout: `HTTP/2 ${status} Response\n${headers}\n\n${status === 304 ? '' : JSON.stringify(value)}`,
  };
}
function fixture() {
  const calls: string[][] = [];
  let reply = response({ revision: 1 });
  const account = {
    identity: { login: 'bot', nodeId: 'U_bot' },
    observationScope: {},
    credentialFingerprint: 'first',
    async execute(argv: string[]) {
      calls.push(argv);
      return reply;
    },
  };
  return {
    account,
    calls,
    set: (value: typeof reply) => {
      reply = value;
    },
    api: new GitHubWorkEventApiClient(account),
  };
}
const conditional = (argv: string[]) => argv.find((value) => value.startsWith('If-None-Match:'));

describe('github conditional reads', () => {
  it('should revalidate across clients and preserve data pagination and fresh quota counters', async () => {
    const f = fixture();
    f.set(
      response(
        [{ revision: 1 }],
        200,
        'etag: "v1"\nlink: <https://api.github.com/next>; rel="next"',
      ),
    );
    const first = await f.api.request(['repos/o/r/issues?page=1'], 'first');
    (first.value as Array<{ revision: number }>)[0]!.revision = 999;
    f.set(response(null, 304, 'etag: "v2"\nx-ratelimit-remaining: 123'));
    const second = new GitHubWorkEventApiClient({ ...f.account });
    assert.deepEqual((await second.request(['repos/o/r/issues?page=1'], 'other label')).value, [
      { revision: 1 },
    ]);
    assert.equal(
      (await second.request(['repos/o/r/issues?page=1'], 'other label')).hasNextPage,
      true,
    );
    assert.equal(second.rateLimit.remaining, 123);
    assert.equal(conditional(f.calls[1]!), 'If-None-Match: "v1"');
    assert.equal(conditional(f.calls[2]!), 'If-None-Match: "v2"');
    assert.equal(f.calls.length, 3);
    f.set(response([{ revision: 2 }]));
    assert.deepEqual((await second.request(['repos/o/r/issues?page=1'], 'read')).value, [
      { revision: 2 },
    ]);
  });

  it('should separate accounts credentials scopes pages projections and api versions', async () => {
    const f = fixture();
    const base = [
      'repos/o/r/issues/1',
      '--jq',
      '{state}',
      '-H',
      'X-GitHub-Api-Version: 2026-03-10',
    ];
    await f.api.request(base, 'read');
    for (const argv of [
      ['repos/o/r/issues/2', ...base.slice(1)],
      [...base, '-f', 'page=2', '--method', 'GET'],
      ['repos/o/r/issues/1', '--jq', '{title}', ...base.slice(3)],
      [...base.slice(0, -1), 'X-GitHub-Api-Version: 2022-11-28'],
    ]) {
      await f.api.request(argv, 'read');
      assert.equal(conditional(f.calls.at(-1)!), undefined);
    }
    for (const account of [
      { ...f.account, observationScope: {} },
      { ...f.account, credentialFingerprint: 'changed' },
      { ...f.account, identity: { login: 'other', nodeId: 'U_other' } },
    ]) {
      await new GitHubWorkEventApiClient(account).request(base, 'read');
      assert.equal(conditional(f.calls.at(-1)!), undefined);
    }
    await f.api.request(base, 'read');
    assert.equal(conditional(f.calls.at(-1)!), 'If-None-Match: "v1"');
  });

  it('should clear rest observations across writes and never send validators on writes or graphql', async () => {
    const f = fixture();
    const get = ['repos/o/r/issues/1'];
    await f.api.request(get, 'read');
    await f.api.request(['graphql', '-f', 'query=query { viewer { login } }'], 'identity');
    assert.equal(conditional(f.calls.at(-1)!), undefined);
    await f.api.request(get, 'read');
    assert.ok(conditional(f.calls.at(-1)!));
    for (const write of [
      ['--method', 'PATCH', ...get],
      [...get, '-f', 'body=changed'],
      ['--method', 'DELETE', ...get],
    ]) {
      await f.api.request(write, 'write');
      assert.equal(conditional(f.calls.at(-1)!), undefined);
      await f.api.request(get, 'read');
      assert.equal(conditional(f.calls.at(-1)!), undefined);
    }
  });

  it('should fail closed and discard observations after denied malformed or interrupted reads', async () => {
    for (const failure of [
      ...[401, 403, 404, 503].map((code) => response({}, code)),
      { ...response({}), timedOut: true },
      { ...response({}), truncated: true },
      { ...response({}), stdout: 'HTTP/2 200 OK\netag: "bad"\n\ninvalid' },
    ]) {
      const f = fixture();
      await f.api.request(['repos/o/r/issues/1'], 'read');
      f.set(failure);
      await assert.rejects(f.api.request(['repos/o/r/issues/1'], 'read'));
      f.set(response({ revision: 2 }));
      await f.api.request(['repos/o/r/issues/1'], 'read');
      assert.equal(conditional(f.calls.at(-1)!), undefined);
    }
  });

  it('should reject unsolicited 304s and avoid caching responses without validators', async () => {
    const f = fixture();
    f.set(response(null, 304));
    await assert.rejects(f.api.request(['user'], 'read'));
    f.set(response({}, 200, ''));
    await f.api.request(['user'], 'read');
    await f.api.request(['user'], 'read');
    assert.ok(f.calls.every((call) => !conditional(call)));
  });

  it('should bound the observation count without serving stale data after eviction', async () => {
    const f = fixture();
    for (let n = 0; n < 129; n++) await f.api.request([`repos/o/r/issues/${n}`], 'read');
    await f.api.request(['repos/o/r/issues/0'], 'read');
    assert.equal(conditional(f.calls.at(-1)!), undefined);
    await f.api.request(['repos/o/r/issues/128'], 'read');
    assert.ok(conditional(f.calls.at(-1)!));
  });
});
