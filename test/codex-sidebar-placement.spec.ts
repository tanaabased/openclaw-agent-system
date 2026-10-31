import assert from 'node:assert/strict';

import codexSidebarPlacement from '../agent/codex-sidebar-placement.ts';

describe('agent/codex-sidebar-placement', () => {
  const inventory = (sections: unknown[]) => ({
    schemaVersion: 4,
    sections,
    unavailableHosts: [],
    unavailableSources: [],
  });
  const group = { sectionId: 'owned-group', name: 'AGENT SYSTEM', itemKeys: [] as string[] };

  it('should create a missing group and reuse an existing group for the exact new coordinator', () => {
    assert.deepEqual(codexSidebarPlacement(inventory([]), 'new').request, {
      tool: 'create_sidebar_section',
      arguments: { name: 'AGENT SYSTEM' },
    });
    const current = inventory([
      { sectionId: 'other', name: 'Other', itemKeys: ['codex:thread:local:new'] },
      { ...group, itemKeys: ['codex:thread:local:old', 'codex:thread:local:unrelated'] },
    ]);
    const before = structuredClone(current);
    assert.deepEqual(codexSidebarPlacement(current, 'new').request, {
      tool: 'move_thread_to_sidebar_section',
      arguments: { threadId: 'new', hostId: 'local', source: 'codex', sectionId: 'owned-group' },
    });
    assert.deepEqual(current, before);
    assert.deepEqual(
      codexSidebarPlacement(inventory([{ ...group, itemKeys: ['codex:thread:local:new'] }]), 'new'),
      { sectionId: 'owned-group' },
    );
  });

  it('should require complete native inventory and reject ambiguous groups', () => {
    for (const value of [
      undefined,
      {},
      { ...inventory([]), unavailableHosts: ['local'] },
      { ...inventory([]), unavailableSources: ['codex'] },
      inventory([{ ...group, itemKeys: null }]),
    ]) {
      assert.throws(
        () => codexSidebarPlacement(value, 'new'),
        /automation-sidebar-inventory-required/,
      );
    }
    assert.throws(
      () => codexSidebarPlacement(inventory([group, { ...group, sectionId: 'duplicate' }]), 'new'),
      /automation-sidebar-ambiguous/,
    );
  });
});
