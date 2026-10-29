import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { connectCodexThreads } from '../agent/codex-thread-client.ts';

function fixture() {
  let now = 0;
  const calls: Array<{ id: number; method: string }> = [];
  const kills: string[] = [];
  const timers = new Set<{ at: number; callback(): void }>();
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null,
    signalCode: null,
    stdin: new Writable({
      write(chunk, _encoding, done) {
        calls.push(JSON.parse(String(chunk)));
        done();
      },
    }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(signal = 'SIGTERM') {
      kills.push(signal);
      if (signal === 'SIGKILL') {
        child.emit('exit');
        child.emit('close');
      }
      return true;
    },
  });
  const dependencies = {
    start: () => child as unknown as ChildProcessWithoutNullStreams,
    realpath: async (path: string) => path,
    now: () => now,
    schedule(callback: () => void, ms: number) {
      const timer = { at: now + ms, callback };
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
  };
  return {
    calls,
    kills,
    timers,
    connect: (signal?: AbortSignal) =>
      connectCodexThreads('/workspace', '/profile', { signal }, dependencies),
    reply(result: Record<string, unknown>) {
      child.stdout.write(JSON.stringify({ id: calls.at(-1)!.id, result }) + '\n');
    },
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        timers.delete(next);
        next.callback();
      }
      now = end;
    },
  };
}

describe('codex thread connection lifecycle', () => {
  for (const version of ['0.159.0', '0.160.1', '0.164.0', undefined]) {
    it(`should gate experimental updates for native version ${version ?? 'unknown'}`, async () => {
      const f = fixture();
      const connecting = f.connect();
      assert.deepEqual((f.calls[0] as unknown as { params: unknown }).params, {
        clientInfo: { name: 'agent_system', version: '1' },
        capabilities: { experimentalApi: true },
      });
      f.reply({
        codexHome: '/profile',
        ...(version ? { userAgent: `agent_system/${version} (fixture)` } : {}),
      });
      const connection = await connecting;
      const update = connection.request('thread/settings/update', {
        threadId: 'native',
        effort: 'high',
      });
      if (version === '0.160.1' || version === '0.164.0') {
        f.reply({});
        await update;
        assert.equal(f.calls.at(-1)!.method, 'thread/settings/update');
      } else {
        await assert.rejects(update, { code: 'automation-thread-settings-unsupported' });
        assert.equal(
          f.calls.some(({ method }) => method === 'thread/settings/update'),
          false,
        );
      }
      const closed = connection.close();
      f.advance(5_000);
      await closed;
    });
  }

  it('should allow cold initialization and materialization beyond the old per-request deadline', async () => {
    const f = fixture();
    const connecting = f.connect();
    f.advance(20_000);
    f.reply({ codexHome: '/profile' });
    const connection = await connecting;
    const starting = connection.request('thread/start', {});
    f.advance(40_000);
    f.reply({ thread: { id: 'native' } });
    assert.deepEqual(await starting, { thread: { id: 'native' } });
    const resuming = connection.request('thread/resume', { threadId: 'native' });
    f.advance(20_000);
    f.reply({ thread: { id: 'native' } });
    await resuming;
    assert.deepEqual(f.kills, []);
    const closed = connection.close();
    f.advance(5_000);
    await closed;
    assert.equal(f.timers.size, 0);
  });

  it('should keep control calls short and force a child only after termination grace', async () => {
    const f = fixture();
    const connecting = f.connect();
    f.reply({ codexHome: '/profile' });
    const connection = await connecting;
    const pending = assert.rejects(connection.request('thread/name/set', {}), {
      code: 'automation-thread-request-timeout',
    });
    f.advance(30_000);
    await pending;
    assert.deepEqual(f.kills, ['SIGTERM']);
    f.advance(4_999);
    assert.deepEqual(f.kills, ['SIGTERM']);
    f.advance(1);
    await connection.close();
    assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL']);
  });

  it('should not renew the connection budget or replay a timed-out native create', async () => {
    const f = fixture();
    const connecting = f.connect();
    f.advance(80_000);
    f.reply({ codexHome: '/profile' });
    const connection = await connecting;
    const pending = assert.rejects(connection.request('thread/start', {}), {
      code: 'automation-thread-request-timeout',
    });
    f.advance(40_000);
    await pending;
    await assert.rejects(connection.request('thread/start', {}));
    assert.equal(f.calls.filter((call) => call.method === 'thread/start').length, 1);
    f.advance(5_000);
    await connection.close();
  });

  it('should cancel outstanding work and clean up without repeating native writes', async () => {
    const f = fixture();
    const controller = new AbortController();
    const connecting = f.connect(controller.signal);
    f.reply({ codexHome: '/profile' });
    const connection = await connecting;
    const pending = assert.rejects(connection.request('thread/start', {}), {
      code: 'automation-thread-request-cancelled',
    });
    controller.abort();
    await pending;
    f.advance(5_000);
    await connection.close();
    assert.equal(f.calls.filter((call) => call.method === 'thread/start').length, 1);
    assert.equal(f.timers.size, 0);
  });
});
