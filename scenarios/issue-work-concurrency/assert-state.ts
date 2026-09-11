import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

async function main(): Promise<void> {
  const phase = process.argv[2];
  assert.ok(['entered', 'open', 'published'].includes(phase ?? ''));
  const gate = join(tmpdir(), 'notification-concurrency');
  const repository = (await readFile(join(gate, 'repository'), 'utf8')).trim();
  const labels = phase === 'entered' ? ['a'] : ['a', 'b', 'c'];
  const numbers = await Promise.all(
    labels.map(async (label) => (await readFile(join(gate, label), 'utf8')).trim()),
  );
  const channelState = join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
    'tanaab/agent-system/notification-data/channels',
  );
  const deadline = Date.now() + 150_000;
  let lastError: unknown;
  while (true) {
    try {
      const sessions = JSON.parse(
        execFileSync(
          'openclaw',
          [
            'gateway',
            'call',
            'sessions.list',
            '--params',
            '{"agentId":"notification-data"}',
            '--json',
          ],
          { encoding: 'utf8', timeout: 15_000 },
        ),
      ) as { sessions: Array<{ key: string; sessionId: string }> };
      const sessionIds = new Set<string>();
      for (const number of numbers) {
        const conversationId = `github:issue:${repository}:${number}`;
        const selected = sessions.sessions.filter((session) =>
          session.key.toLowerCase().endsWith(`:direct:${conversationId.toLowerCase()}`),
        );
        assert.equal(selected.length, 1, `issue ${number} must have exactly one durable session`);
        assert.ok(selected[0]!.sessionId);
        sessionIds.add(selected[0]!.sessionId);
        await readFile(join(gate, `entered-${number}`));
        const digest = createHash('sha256').update(conversationId).digest('hex');
        const snapshot = JSON.parse(
          await readFile(
            join(channelState, 'github-notification-conversations', `${digest}.json`),
            'utf8',
          ),
        );
        assert.equal(snapshot.conversation.acknowledgment.status, 'published');
        const candidatePath = join(
          channelState,
          'github-notification-reply-turns',
          `${digest}.json`,
        );
        if (phase === 'published') {
          assert.equal(snapshot.conversation.assignmentResponse.status, 'published');
          assert.equal(snapshot.conversation.activeTurn, undefined);
          await assert.rejects(readFile(candidatePath), { code: 'ENOENT' });
        } else {
          assert.equal(snapshot.conversation.assignmentResponse, undefined);
          const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
          assert.equal(candidate.conversationId, conversationId);
          assert.equal(candidate.identity.eventId, 'assignment');
          assert.ok(candidate.promptSelectedAt);
          assert.ok(Date.parse(candidate.expiresAt) > Date.now());
        }
      }
      assert.equal(sessionIds.size, numbers.length);
      break;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline)
      throw new Error(`Concurrent assignment ${phase} assertions timed out`, { cause: lastError });
    await setTimeout(1_000);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
