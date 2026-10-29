import assert from 'node:assert/strict';

import automationContent from '../manifest/automation-content.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';
import managedGroupName from '../utils/managed-group-name.ts';

const base = { id: 'review', prompt: 'Review.', schedule: 'every 1 hour' };
describe('manifest/automation-thread-schema', () => {
  it('should normalize persistent groups without changing titles or scheduling hashes', () => {
    const normalized = normalizeAutomations([
      { ...base, thread: 'Nightly review', group: '  straße 🌙 / ops  ' },
    ]);
    assert.equal(normalized.status, 'valid');
    if (normalized.status !== 'valid') return;
    const job = normalized.automations[0] as ResolvedAutomation;
    assert.equal(job.group, 'STRASSE 🌙 / OPS');
    assert.deepEqual(job.thread, { name: 'Nightly review' });
    const before = automationContent(job, 'openclaw');
    job.group = 'OTHER';
    assert.deepEqual(automationContent(job, 'openclaw'), before);
    assert.equal(managedGroupName('ß'.repeat(256), 512).length, 512);
    assert.throws(() => managedGroupName('ß'.repeat(257), 512), /too-long/);
  });
  it('should reject invalid groups and group declarations on effective independent runs', () => {
    for (const group of [
      '',
      ' ',
      '\tgroup',
      'group\n',
      'group\x7f',
      'group\u0085',
      'group\u2028',
      'ß'.repeat(257),
    ])
      assert.equal(normalizeAutomations([{ ...base, thread: 'Review', group }]).status, 'invalid');
    for (const job of [
      { ...base, group: 'ops' },
      { ...base, thread: 'Review', group: 'ops', overrides: { codex: { target: 'independent' } } },
      { id: 'command', schedule: 'every 1 hour', run: ['true'], group: 'ops' },
    ])
      assert.equal(normalizeAutomations([job]).status, 'invalid');
    for (const runtime of ['codex', 'openclaw']) {
      assert.equal(
        normalizeAutomations([
          {
            ...base,
            runtimes: [runtime],
            group: 'ops',
            overrides: { [runtime]: { target: { thread: 'existing' } } },
          },
        ]).status,
        'valid',
      );
    }
  });
  it('should normalize every accepted declaration and keep independent defaults unchanged', () => {
    for (const [thread, expected] of [
      [null, undefined],
      [' Activity ', { name: 'Activity' }],
      [{ name: 'Activity' }, { name: 'Activity' }],
      [
        { id: ' activity ', name: ' Activity ' },
        { id: 'activity', name: 'Activity' },
      ],
    ] as const) {
      const result = normalizeAutomations([{ ...base, thread }]);
      assert.equal(result.status, 'valid');
      if (result.status === 'valid') assert.deepEqual(result.automations[0]?.thread, expected);
    }
  });
  it('should reject empty, blank, unknown, and command thread declarations', () => {
    for (const thread of [
      '',
      '  ',
      {},
      { id: '' },
      { name: ' ' },
      { id: 'activity', extra: true },
      1,
    ])
      assert.equal(normalizeAutomations([{ ...base, thread }]).status, 'invalid');
    for (const thread of [null, 'Activity', { id: 'activity' }])
      assert.equal(
        normalizeAutomations([{ id: 'command', schedule: 'every 1 hour', run: ['true'], thread }])
          .status,
        'invalid',
      );
  });
  it('should hash effective thread declarations but ignore them behind explicit target overrides', () => {
    const result = normalizeAutomations([{ ...base, thread: { id: 'activity' } }]);
    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    const job = result.automations[0] as ResolvedAutomation;
    const original = automationContent(job, 'openclaw').hash;
    job.thread = { id: 'different' };
    assert.notEqual(automationContent(job, 'openclaw').hash, original);
    job.overrides.openclaw = { target: 'independent' };
    const overridden = automationContent(job, 'openclaw').hash;
    delete job.thread;
    assert.equal(automationContent(job, 'openclaw').hash, overridden);
  });
});
