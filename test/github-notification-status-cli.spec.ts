import assert from 'node:assert/strict';
import ansis from 'ansis';
import stringWidth from 'fast-string-width';
import {
  captureStatusFixture,
  statusFixtureAgent,
  statusFixtureNames,
  statusFixtureSelector,
} from './github-notification-status-fixtures.ts';

describe('channels/github/cli/status', () => {
  it('should forward the trusted agent and selector while retaining agent-wide capacity', async () => {
    const all = await captureStatusFixture('healthy');
    assert.deepEqual(all.calls, [[statusFixtureAgent, undefined]]);
    assert.match(all.events[0]!.text, /agent-wide active=1 queued=1 limit=2/u);
    const selected = await captureStatusFixture('filtered');
    assert.deepEqual(selected.calls, [[statusFixtureAgent, statusFixtureSelector]]);
    assert.match(selected.events[0]!.text, /agent-wide active=0 queued=1 limit=2/u);
    assert.ok(!selected.events[0]!.text.includes('tanaabased/example'));
    const missing = await captureStatusFixture('healthy', {
      selector: { ...statusFixtureSelector, number: 999 },
    });
    assert.match(missing.events[0]!.text, /no matching items/u);
    assert.match((await captureStatusFixture('empty')).events[0]!.text, /no items/u);
  });
  it('should keep color previews equivalent at narrow and wide widths', async () => {
    for (const name of statusFixtureNames)
      for (const columns of [40, 120]) {
        const plain = await captureStatusFixture(name, { columns });
        const color = await captureStatusFixture(name, { columns, color: true });
        assert.deepEqual(
          color.events.map((e) => ({ ...e, text: ansis.strip(e.text) })),
          plain.events,
        );
        for (const e of plain.events)
          assert.ok(e.text.split('\n').every((line) => stringWidth(line) <= columns));
      }
  });
  it('should retain structured status and nonzero failures without contaminating json', async () => {
    for (const name of statusFixtureNames) {
      const result = await captureStatusFixture(name, { json: true, color: true });
      const value = JSON.parse(result.events[0]!.text);
      assert.equal(value.schemaVersion, 2);
      assert.equal(value.agentId, statusFixtureAgent);
      assert.equal(result.exitCode, name === 'degraded' ? 1 : 0);
      assert.ok(
        !result.events.some((e) => e.text.includes('\u001b') || e.text.includes('messages')),
      );
    }
  });
  it('should reject invalid options and unmanaged manifests before observation', async () => {
    assert.deepEqual((await captureStatusFixture('healthy', { itemKind: 'invalid' })).calls, []);
    assert.deepEqual(
      (await captureStatusFixture('healthy', { manifestStatus: 'unmanaged' })).calls,
      [],
    );
  });
});
