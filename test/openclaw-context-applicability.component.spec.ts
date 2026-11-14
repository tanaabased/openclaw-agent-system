import assert from 'node:assert/strict';
import openclawDispatchFixture from './openclaw-dispatch-fixture.ts';

describe('agent/openclaw context applicability', () => {
  const f = openclawDispatchFixture();
  const read = (who = f.coordinator) =>
    f.service.runModel(f.manifest, f.root, who, { action: 'context' });
  const prompt = (who = f.coordinator) =>
    f.service.promptContext(f.manifest, f.root, { ...who, agentId: f.manifest.agent.id });

  it('should quietly read unmanaged home and intake chats before and after starting issue work', async () => {
    for (const sessionKey of ['agent:receiver:main', f.coordinator.sessionKey]) {
      const who = { ...f.coordinator, sessionKey };
      const output = await read(who);
      assert.equal(output.status, 'unmanaged-turn');
      assert.equal('notice' in output, false);
      assert.equal('context' in output, false);
      assert.equal(await prompt(who), undefined);
    }
    const input = await f.next();
    await f.prepare(input);
    await f.assess(input.id);
    const who = f.assessor(input.id);
    const managed = await read(who);
    assert.equal(managed.status, 'verified');
    assert.ok('evidence' in managed);
    assert.ok(await prompt(who));
    assert.equal((await read()).status, 'unmanaged-turn');
    assert.equal(await prompt(), undefined);
  });

  it('should reject missing expected issue ownership rather than declare the chat unmanaged', async () => {
    const who = f.assessor('missing');
    await assert.rejects(read(who), /native-context-owner-unavailable/);
    await assert.rejects(prompt(who), /native-context-owner-unavailable/);
  });

  for (const change of ['session', 'agent', 'reset', 'superseded', 'thread', 'ambiguous'] as const)
    it(`should retain failure handling for ${change} ownership`, async () => {
      const input = await f.next();
      await f.prepare(input);
      await f.assess(input.id);
      const who = f.assessor(input.id);
      const current = await f.service.scope(f.manifest, f.root);
      if (change === 'session') who.sessionId = 'replacement';
      else
        await current.journal.exclusive(async (state, save) => {
          const record = state.records[0]!;
          if (change === 'agent') record.request!.agentId = 'foreign';
          if (change === 'reset') record.reset = { at: 1, by: 'operator' };
          if (change === 'superseded') record.supersededBy = 'b'.repeat(64);
          if (change === 'thread') {
            delete record.threadId;
            delete record.sessionCreation!.verified;
            delete record.effective;
          }
          if (change === 'ambiguous')
            state.records.push({
              ...record,
              id: 'b'.repeat(64),
              worktreeAttemptId: 'b'.repeat(64),
              issueKey: 'c'.repeat(64),
            });
          await save();
        });
      const code =
        change === 'ambiguous'
          ? /native-context-owner-ambiguous/
          : /native-context-owner-unverified/;
      await assert.rejects(read(who), code);
      await assert.rejects(prompt(who), code);
    });
});
