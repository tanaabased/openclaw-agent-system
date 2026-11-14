import assert from 'node:assert/strict';
import openclawDispatchFixture from './openclaw-dispatch-fixture.ts';

describe('agent/openclaw manual dispatch discovery', () => {
  const fixture = openclawDispatchFixture({ discover: false });

  it('should discover a fresh assignment and deliver assessment without a trigger scan', async () => {
    const before = await fixture.fixtureIntake.inspect(fixture.manifest, fixture.root);
    assert.equal(before.records.length, 0);
    const selected = await fixture.next();
    assert.equal((await fixture.prepare(selected)).status, 'session-created');
    assert.equal((await fixture.assess(selected.id)).status, 'assessment-pending');
    assert.equal(fixture.creates().length, 1);
    assert.equal(fixture.sends().length, 1);
  });

  it('should reuse this scheduled occurrence scan without rescanning on repeated next calls', async () => {
    const startedAt = Date.now();
    await fixture.service.check(fixture.manifest, fixture.root);
    fixture.service.dependencies.occurrenceStartedAt = async () => startedAt;
    fixture.fixture.client.discoverAssigned = async () => {
      throw new Error('scheduled discovery must be reused');
    };
    const selected = await fixture.next();
    await fixture.prepare(selected);
    await fixture.assess(selected.id);
    await fixture.service.run(fixture.manifest, fixture.root, fixture.coordinator, {
      action: 'next',
    });
    assert.equal(fixture.creates().length, 1);
    assert.equal(fixture.sends().length, 1);
  });

  it('should not reuse a recent scan from a previous occurrence for manual entry', async () => {
    const discover = fixture.fixture.client.discoverAssigned;
    fixture.fixture.client.discoverAssigned = async () => ({
      candidates: [],
      incomplete: false,
      totalCount: 0,
      truncated: false,
    });
    await fixture.service.check(fixture.manifest, fixture.root);
    fixture.fixture.client.discoverAssigned = discover;
    const { journal } = await fixture.service.scope(fixture.manifest, fixture.root);
    const previous = (await journal.read()).discoveryCheckedAt!;
    fixture.service.dependencies.occurrenceStartedAt = async () => previous + 1;
    const selected = await fixture.next();
    assert.equal((await fixture.prepare(selected)).status, 'session-created');
  });

  it('should not report idle when manual assignment discovery fails', async () => {
    fixture.fixture.client.discoverAssigned = async () => {
      throw new Error('fixture-discovery-failed');
    };
    await assert.rejects(
      fixture.service.run(fixture.manifest, fixture.root, fixture.coordinator, { action: 'next' }),
    );
    assert.equal(fixture.creates().length, 0);
  });

  it('should discover and route feedback in a manual run without a trigger check', async () => {
    const { id } = await fixture.feedbackOwner(true, false);
    await fixture.service.run(fixture.manifest, fixture.root, fixture.coordinator, {
      action: 'next',
    });
    const event = (await fixture.record()).feedback?.events[0];
    assert.equal(event?.turn?.status, 'accepted');
    assert.match(event?.turn?.message ?? '', /issuecomment-99/);
    assert.equal(fixture.sends().length, 2);
    assert.equal(fixture.creates().length, 1);
    assert.ok((await fixture.record()).feedback?.events.length);
    assert.equal((await fixture.record()).id, id);
  });
});
