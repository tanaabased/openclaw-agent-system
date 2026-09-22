import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import waitForConcurrencyState from '../scenarios/issue-work-concurrency/wait-for-state.ts';

describe('notification concurrency readiness', () => {
  function fixture() {
    let now = 0;
    let polls = 0;
    const files = new Map<string, string>([
      ['/gate/repository', 'repo'],
      ['/gate/a', '1'],
      ['/gate/b', '2'],
      ['/gate/c', '3'],
    ]);
    const sessions = [1, 2].map((number) => ({
      key: `agent:test:direct:github:issue:repo:${number}`,
      sessionId: `session-${number}`,
    }));
    for (const number of [1, 2]) {
      const conversationId = `github:issue:repo:${number}`;
      const digest = createHash('sha256').update(conversationId).digest('hex');
      files.set(`/gate/entered-${number}`, 'entered');
      files.set(
        join('/state/github-notification-conversations', `${digest}.json`),
        JSON.stringify({ conversation: { acknowledgment: { status: 'published' } } }),
      );
      files.set(
        join('/state/github-notification-reply-turns', `${digest}.json`),
        JSON.stringify({
          conversationId,
          identity: { eventId: 'assignment' },
          promptSelectedAt: 'selected',
          expiresAt: new Date(240_000).toISOString(),
        }),
      );
    }
    const status = {
      capacity: { active: 2, limit: 2, queued: 0 },
      items: [] as Array<{ number: number; scheduling: string }>,
    };
    const options = {
      phase: 'limited' as const,
      gate: '/gate',
      channelState: '/state',
      async read(path: string) {
        if (!files.has(path)) throw Object.assign(new Error('missing fixture'), { code: 'ENOENT' });
        return files.get(path)!;
      },
      sessions: () => ({ sessions }),
      status: () => {
        polls++;
        return status;
      },
      clock: () => now,
      async sleep(ms: number) {
        now += ms;
      },
    };
    return { options, files, sessions, status, polls: () => polls };
  }

  it('should verify the first held turn before later assignments exist', async () => {
    const f = fixture();
    f.files.delete('/gate/b');
    f.files.delete('/gate/c');
    await waitForConcurrencyState({ ...f.options, phase: 'entered' });
    assert.equal(f.polls(), 0);
  });

  it('should keep waiting when both turns are active but the third assignment has not been discovered', async () => {
    const f = fixture();
    const sleep = f.options.sleep;
    f.options.sleep = async (ms) => {
      await sleep(ms);
      f.status.capacity.queued = 1;
      f.status.items = [{ number: 3, scheduling: 'queued' }];
    };
    await waitForConcurrencyState(f.options);
    assert.equal(f.polls(), 2);
  });

  it('should retry a transient status read within the same deadline', async () => {
    const f = fixture();
    f.status.capacity.queued = 1;
    f.status.items = [{ number: 3, scheduling: 'queued' }];
    const status = f.options.status;
    let calls = 0;
    f.options.status = () => {
      if (calls++ === 0) throw new Error('temporary gateway read failure');
      return status();
    };
    await waitForConcurrencyState(f.options);
    assert.equal(calls, 2);
  });

  it('should require the expected issue to be queued rather than accepting a count alone', async () => {
    const f = fixture();
    f.status.capacity.queued = 1;
    f.status.items = [{ number: 99, scheduling: 'queued' }];
    await assert.rejects(
      waitForConcurrencyState(f.options),
      /timed out.*Latest scheduler status.*99/u,
    );
    assert.equal(f.options.clock(), 150_000);
  });

  it('should fail immediately if the queued issue gets a session or enters the provider', async () => {
    for (const violation of ['session', 'provider']) {
      const f = fixture();
      if (violation === 'session')
        f.sessions.push({ key: 'agent:test:direct:github:issue:repo:3', sessionId: 'session-3' });
      else f.files.set('/gate/entered-3', 'entered');
      await assert.rejects(waitForConcurrencyState(f.options), assert.AssertionError);
      assert.equal(f.options.clock(), 0);
    }
  });

  it('should fail immediately on excess capacity or a provider fixture error', async () => {
    for (const violation of ['capacity', 'fixture']) {
      const f = fixture();
      if (violation === 'capacity') f.status.capacity.active = 3;
      else f.files.set('/gate/fixture-error', 'unexpected request');
      await assert.rejects(waitForConcurrencyState(f.options), assert.AssertionError);
      assert.equal(f.options.clock(), 0);
    }
  });
});
