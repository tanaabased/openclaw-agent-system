import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

interface Sessions {
  sessions: Array<{ key: string; sessionId?: string }>;
}

interface Status {
  capacity: { active: number; limit: number; queued: number };
  items: Array<{ number: number; scheduling?: string }>;
}

interface Options {
  phase: 'entered' | 'limited';
  gate: string;
  channelState: string;
  read(path: string): Promise<string>;
  sessions(): Sessions;
  status(): Status;
  clock(): number;
  sleep(milliseconds: number): Promise<unknown>;
}

/** Wait for the complete capacity checkpoint while rejecting forbidden execution immediately. */
export default async function waitForConcurrencyState(options: Options): Promise<void> {
  const { phase, gate, channelState, read, clock } = options;
  const repository = (await read(join(gate, 'repository'))).trim();
  const labels = phase === 'entered' ? ['a'] : ['a', 'b'];
  const numbers = await Promise.all(
    labels.map(async (label) => (await read(join(gate, label))).trim()),
  );
  const queuedNumber = phase === 'limited' ? (await read(join(gate, 'c'))).trim() : undefined;
  const conversationId = (number: string) => `github:issue:${repository}:${number}`;
  const matches = (key: string, number: string) =>
    key.toLowerCase().endsWith(`:direct:${conversationId(number).toLowerCase()}`);
  const deadline = clock() + 150_000;
  let lastError: unknown;
  let status: Status | undefined;
  while (true) {
    const fixtureError = await read(join(gate, 'fixture-error')).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return undefined;
    });
    assert.equal(fixtureError, undefined, fixtureError ?? 'provider fixture must remain valid');
    let sessions: Sessions | undefined;
    try {
      sessions = options.sessions();
      if (queuedNumber) status = options.status();
    } catch (error) {
      lastError = error;
      sessions = undefined;
    }
    if (sessions) {
      if (queuedNumber) {
        assert.equal(status!.capacity.limit, 2);
        assert.ok(status!.capacity.active <= 2, 'the scheduler must not exceed its capacity');
        assert.equal(
          sessions.sessions.some(({ key }) => matches(key, queuedNumber)),
          false,
          `issue ${queuedNumber} must remain queued without a durable session`,
        );
        await assert.rejects(read(join(gate, `entered-${queuedNumber}`)), { code: 'ENOENT' });
      }
      try {
        const sessionIds = new Set<string>();
        for (const number of numbers) {
          const selected: Sessions['sessions'] = sessions.sessions.filter(({ key }) =>
            matches(key, number),
          );
          assert.equal(selected.length, 1, `issue ${number} must have exactly one durable session`);
          assert.ok(selected[0]!.sessionId);
          sessionIds.add(selected[0]!.sessionId);
          await read(join(gate, `entered-${number}`));
          const id = conversationId(number);
          const digest = createHash('sha256').update(id).digest('hex');
          const snapshot = JSON.parse(
            await read(join(channelState, 'github-notification-conversations', `${digest}.json`)),
          );
          assert.equal(snapshot.conversation.acknowledgment.status, 'published');
          assert.equal(snapshot.conversation.assignmentResponse, undefined);
          const candidate = JSON.parse(
            await read(join(channelState, 'github-notification-reply-turns', `${digest}.json`)),
          );
          assert.equal(candidate.conversationId, id);
          assert.equal(candidate.identity.eventId, 'assignment');
          assert.ok(candidate.promptSelectedAt);
          assert.ok(Date.parse(candidate.expiresAt) > clock());
        }
        assert.equal(sessionIds.size, numbers.length);
        if (queuedNumber) {
          assert.deepEqual(status!.capacity, { active: 2, limit: 2, queued: 1 });
          assert.equal(
            status!.items.find(({ number }) => number === Number(queuedNumber))?.scheduling,
            'queued',
          );
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (clock() >= deadline) {
      throw new Error(
        `Concurrent assignment ${phase} assertions timed out. Latest scheduler status: ${JSON.stringify(status)}`,
        { cause: lastError },
      );
    }
    await options.sleep(Math.min(1_000, deadline - clock()));
  }
}
