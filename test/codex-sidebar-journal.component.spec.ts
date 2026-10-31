import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';

import CodexSidebarJournal from '../agent/codex-sidebar-journal.ts';
import codexSidebarPlacement from '../agent/codex-sidebar-placement.ts';

describe('agent/codex-sidebar-journal', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp('/tmp/sidebar-journal-');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const inventory = (
    sections: Array<{ sectionId: string; name: string; itemKeys: string[] }> = [],
  ) => ({
    schemaVersion: 4,
    unavailableHosts: [],
    unavailableSources: [],
    sections,
  });
  const section = (id: string, name = 'OPERATIONS', thread?: string) => ({
    sectionId: id,
    name,
    itemKeys: thread ? [`codex:thread:local:${thread}`] : [],
  });

  it('should reuse exact uppercase destinations and leave lowercase destinations untouched', async () => {
    const journal = new CodexSidebarJournal(root, 'profile', ' operations ');
    const current = inventory([section('lower', 'operations'), section('upper')]);
    const before = structuredClone(current);
    const plan = await journal.inspect(current, 'chat');
    assert.equal(plan.placement.sectionId, 'upper');
    assert.equal((await readdir(root)).length, 0);
    assert.deepEqual(current, before);
    assert.equal(
      codexSidebarPlacement(inventory([section('lower', 'operations')]), 'chat', 'operations')
        .request?.tool,
      'create_sidebar_section',
    );
    const move = await journal.apply('workspace-a', current, 'chat');
    assert.equal(move.status, 'native-action');
    if (move.status !== 'native-action') return;
    assert.equal(move.request.tool, 'move_thread_to_sidebar_section');
    assert.equal((await journal.apply('workspace-a', current, 'chat')).status, 'incomplete');
    current.sections[1]!.itemKeys.push('codex:thread:local:chat');
    assert.equal(
      (
        await journal.apply('workspace-a', current, 'chat', {
          digest: move.digest,
          sectionId: 'upper',
        })
      ).status,
      'done',
    );
    assert.equal((await journal.apply('workspace-a', current, 'chat')).status, 'done');
    assert.equal(current.sections[0]!.name, 'operations');
  });
  it('should serialize creates across workspaces and recover lost responses without replay', async () => {
    const a = new CodexSidebarJournal(root, 'profile', 'operations');
    const b = new CodexSidebarJournal(root, 'profile', 'OPERATIONS');
    const results = await Promise.all([
      a.apply('a', inventory(), 'chat-a'),
      b.apply('b', inventory(), 'chat-b'),
    ]);
    assert.equal(results.filter(({ status }) => status === 'native-action').length, 1);
    const pending = (await a.read()).pending!;
    const recovered = await b.apply('b', inventory([section('created')]), 'chat-b');
    assert.equal(recovered.status, 'native-action');
    if (recovered.status !== 'native-action') return;
    assert.equal(recovered.request.tool, 'move_thread_to_sidebar_section');
    assert.equal((await a.read()).sectionId, 'created');
    assert.notEqual((await a.read()).pending!.digest, pending.digest);
    assert.equal((await a.apply('a', inventory(), 'chat-a')).status, 'incomplete');
  });
  for (const changed of ['deleted', 'renamed']) {
    it(`should reconcile a ${changed} confirmed group without replaying an unresolved creation`, async () => {
      const journal = new CodexSidebarJournal(root, 'profile', 'operations');
      assert.equal(
        (await journal.apply('a', inventory([section('old', 'OPERATIONS', 'chat')]), 'chat'))
          .status,
        'done',
      );
      const current = inventory(changed === 'renamed' ? [section('old', 'PERSONAL', 'chat')] : []);
      await assert.rejects(
        journal.apply('a', { ...current, unavailableHosts: ['local'] }, 'chat'),
        /inventory-required/,
      );
      assert.equal((await journal.read()).sectionId, 'old');
      const create = await journal.apply('a', current, 'chat');
      assert.equal(create.status, 'native-action');
      if (create.status !== 'native-action') return;
      assert.deepEqual(create.request, {
        tool: 'create_sidebar_section',
        arguments: { name: 'OPERATIONS' },
      });
      assert.equal((await journal.apply('a', current, 'chat')).status, 'incomplete');
      assert.equal((await journal.apply('b', current, 'other-chat')).status, 'incomplete');
      current.sections.push(section('replacement'));
      const move = await journal.apply('a', current, 'chat', {
        digest: create.digest,
        sectionId: 'replacement',
      });
      assert.equal(move.status, 'native-action');
      if (move.status !== 'native-action') return;
      assert.deepEqual(move.request, {
        tool: 'move_thread_to_sidebar_section',
        arguments: { threadId: 'chat', hostId: 'local', source: 'codex', sectionId: 'replacement' },
      });
      for (const entry of current.sections) entry.itemKeys = [];
      current.sections.at(-1)!.itemKeys.push('codex:thread:local:chat');
      assert.deepEqual(
        await journal.apply('a', current, 'chat', {
          digest: move.digest,
          sectionId: 'replacement',
        }),
        { status: 'done', sectionId: 'replacement' },
      );
      assert.equal((await journal.apply('a', current, 'chat')).status, 'done');
      if (changed === 'renamed') assert.equal(current.sections[0]!.name, 'PERSONAL');
    });
  }
  it('should retain a returned id before incomplete readback and refuse ambiguous recovery', async () => {
    const journal = new CodexSidebarJournal(root, 'profile', 'operations');
    const prepared = await journal.apply('a', inventory(), 'chat');
    assert.equal(prepared.status, 'native-action');
    if (prepared.status !== 'native-action') return;
    assert.equal(
      (
        await journal.apply('a', inventory(), 'chat', {
          digest: prepared.digest,
          sectionId: 'created',
        })
      ).status,
      'incomplete',
    );
    assert.equal((await journal.read()).pending!.sectionId, 'created');
    await assert.rejects(
      journal.apply('b', inventory(), 'chat', { digest: prepared.digest, sectionId: 'created' }),
      /receipt-mismatch/,
    );
    const next = await journal.apply(
      'a',
      inventory([section('other'), section('created')]),
      'chat',
    );
    assert.equal(next.status, 'native-action');
    if (next.status === 'native-action')
      assert.equal(next.request.tool, 'move_thread_to_sidebar_section');
    const unknown = new CodexSidebarJournal(root, 'other-profile', 'operations');
    await unknown.apply('a', inventory(), 'chat');
    const ambiguous = await unknown.apply('a', inventory([section('one'), section('two')]), 'chat');
    assert.ok(
      ambiguous.status === 'incomplete' && ambiguous.code === 'automation-sidebar-ambiguous',
    );
    await assert.rejects(
      journal.apply('a', { ...inventory(), unavailableHosts: ['local'] }, 'chat'),
      /inventory-required/,
    );
  });
});
