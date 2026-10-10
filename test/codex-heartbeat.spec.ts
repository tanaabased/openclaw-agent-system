import assert from 'node:assert/strict';

import codexHeartbeat from '../agent/codex-heartbeat.ts';

const request = {
  automationId: 'native-intake-job',
  currentTimeIso: '2026-10-09T12:00:00.000Z',
  intake: { status: 'ready', changed: false },
  dispatch: [{ status: 'idle', changed: false }],
};

function quiet(currentTimeIso = request.currentTimeIso, timeZone = 'UTC') {
  const result = codexHeartbeat({ ...request, currentTimeIso }, timeZone);
  assert.equal(result.status, 'quiet');
  if (result.status !== 'quiet') throw new Error('expected quiet response');
  return result;
}

describe('agent/codex-heartbeat', () => {
  it('should select every daypart at its host-local boundaries including midnight', () => {
    for (const [time, period] of [
      ['00:00:00.000', 'night'],
      ['04:59:59.999', 'night'],
      ['05:00:00.000', 'morning'],
      ['11:59:59.999', 'morning'],
      ['12:00:00.000', 'afternoon'],
      ['16:59:59.999', 'afternoon'],
      ['17:00:00.000', 'evening'],
      ['21:59:59.999', 'evening'],
      ['22:00:00.000', 'night'],
      ['23:59:59.999', 'night'],
    ]) {
      const result = quiet(`2026-10-09T${time}Z`);
      assert.equal(result.period, period);
      assert.match(result.message.toLowerCase(), new RegExp(period!));
    }
  });

  it('should use the executing host timezone and its daylight saving offset', () => {
    assert.equal(quiet('2026-07-01T09:00:00.000Z', 'America/New_York').period, 'morning');
    assert.equal(quiet('2026-01-01T09:00:00.000Z', 'America/New_York').period, 'night');
    assert.equal(quiet('2026-07-01T03:00:00.000Z', 'America/New_York').period, 'night');
    assert.equal(quiet('2026-07-01T03:00:00.000Z', 'Asia/Tokyo').period, 'afternoon');
    const previous = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      assert.deepEqual(codexHeartbeat(request), codexHeartbeat(request, 'America/New_York'));
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it('should rotate within a small collection using only the occurrence time', () => {
    for (const hour of ['06', '12', '17', '00']) {
      const start = Date.parse(`2026-10-09T${hour}:00:00.000Z`);
      const period = quiet(new Date(start).toISOString()).period;
      for (const intervalMinutes of [5, 15, 30, 60, 1_440]) {
        const responses = Array.from({ length: 12 }, (_, occurrence) =>
          quiet(new Date(start + occurrence * intervalMinutes * 60_000).toISOString()),
        ).filter((result) => result.period === period);
        const collection = new Set(responses.map((result) => result.message));
        assert.ok(
          collection.size > 1 && collection.size <= 5,
          `expected varied ${period} messages at a ${intervalMinutes}-minute cadence`,
        );
      }
    }
    const before = quiet();
    const originalNow = Date.now;
    Date.now = () => Date.parse('2040-01-01T23:00:00.000Z');
    try {
      assert.deepEqual(quiet(), before);
    } finally {
      Date.now = originalNow;
    }
    assert.ok(quiet('1960-01-01T06:00:00.000Z').message.length);
  });

  it('should preserve the native quiet envelope and its automation identity without outside prose', () => {
    const result = quiet();
    assert.equal(
      result.response,
      `<heartbeat>\n  <automation_id>${request.automationId}</automation_id>\n  <decision>DONT_NOTIFY</decision>\n  <message>${result.message}</message>\n</heartbeat>`,
    );
    assert.ok(result.message.length > 0 && result.message.length < 120);
    const escaped = codexHeartbeat({ ...request, automationId: 'native<&>job' }, 'UTC');
    assert.equal(escaped.status, 'quiet');
    if (escaped.status === 'quiet')
      assert.match(escaped.response, /<automation_id>native&lt;&amp;&gt;job<\/automation_id>/u);
  });

  it('should offer five concise messages per daypart with a distinct emoji for every message', () => {
    const emojis = new Set<string>();
    for (const hour of ['06', '12', '17', '00']) {
      const start = Date.parse(`2026-10-09T${hour}:00:00.000Z`);
      const collection = new Set(
        Array.from(
          { length: 120 },
          (_, occurrence) => quiet(new Date(start + occurrence * 60_000).toISOString()).message,
        ),
      );
      assert.equal(collection.size, 5);
      for (const message of collection) {
        const emoji = message.split(' ')[0]!;
        assert.match(emoji, /\p{Extended_Pictographic}/u);
        assert.equal(emojis.has(emoji), false, `repeated emoji: ${emoji}`);
        emojis.add(emoji);
        assert.ok(message.length < 120);
        assert.match(message, /no new update|nothing new to report/iu);
        assert.doesNotMatch(message, /queue.*empty|all.*done|work.*finished/iu);
      }
    }
  });

  it('should keep ordinary pending work quiet without asserting that the queue is empty', () => {
    for (const status of ['at-capacity', 'creating']) {
      const result = codexHeartbeat({
        ...request,
        dispatch: [
          { status: 'busy', changed: false },
          { status, changed: false },
        ],
      });
      assert.equal(result.status, 'quiet');
      if (result.status === 'quiet')
        assert.doesNotMatch(result.message, /queue.*empty|all.*done|work.*finished/iu);
    }
  });

  it('should never hide changed work, recovery, failures, approval, or exhausted busy polling', () => {
    for (const intake of [
      { status: 'ready', changed: true },
      { status: 'blocked', changed: false },
      { status: 'busy', changed: false },
    ])
      assert.deepEqual(codexHeartbeat({ ...request, intake }), { status: 'not-quiet' });
    for (const status of [
      'routing-required',
      'prepared',
      'completed',
      'blocked',
      'approval-required',
      'failed',
      'recovered',
      'busy',
      'unknown',
    ])
      assert.deepEqual(codexHeartbeat({ ...request, dispatch: [{ status, changed: false }] }), {
        status: 'not-quiet',
      });
    for (const earlier of [
      { status: 'creating', changed: true },
      { status: 'completed', changed: true },
      { status: 'blocked', changed: false },
    ])
      assert.deepEqual(codexHeartbeat({ ...request, dispatch: [earlier, ...request.dispatch] }), {
        status: 'not-quiet',
      });
  });

  it('should use neutral wording for missing or invalid native occurrence time', () => {
    for (const currentTimeIso of [
      undefined,
      null,
      1791547200000,
      '',
      '2026-10-09',
      '2026-02-30T12:00:00.000Z',
      'invalid',
    ]) {
      const result = codexHeartbeat({ ...request, currentTimeIso });
      assert.equal(result.status, 'quiet');
      if (result.status === 'quiet') {
        assert.equal(result.period, null);
        assert.doesNotMatch(result.message, /morning|afternoon|evening|night|[☕☀🌙🦉]/iu);
        assert.match(result.response, /<decision>DONT_NOTIFY<\/decision>/u);
      }
    }
  });

  it('should reject malformed requests rather than infer quiet outcomes or an automation id', () => {
    for (const invalid of [
      null,
      [],
      {},
      { ...request, extra: true },
      { ...request, automationId: '' },
      { ...request, automationId: ' native-job ' },
      { ...request, intake: { status: 'ready' } },
      { ...request, intake: { status: 'ready', changed: 'false' } },
      { ...request, dispatch: [] },
      { ...request, dispatch: Array(13).fill(request.dispatch[0]) },
      { ...request, dispatch: [{ ...request.dispatch[0], message: 'quiet' }] },
    ])
      assert.throws(() => codexHeartbeat(invalid), /heartbeat-request-invalid/u);
  });
});
