import assert from 'node:assert/strict';

import codexResetPlacement from '../agent/codex-reset-placement.ts';

describe('agent/codex-reset-placement', () => {
  const inventory = (sections: unknown[]) => ({
    schemaVersion: 4,
    sections,
    unavailableHosts: [],
    unavailableSources: [],
  });
  const group = { sectionId: 'owned-group', name: 'AGENT SYSTEM', itemKeys: [] as string[] };

  it('should create a missing group and reuse an existing group for the exact new coordinator', () => {
    assert.deepEqual(codexResetPlacement(inventory([]), 'new').request, {
      tool: 'create_sidebar_section',
      arguments: { name: 'AGENT SYSTEM' },
    });
    const current = inventory([
      { sectionId: 'other', name: 'Other', itemKeys: ['codex:thread:local:new'] },
      { ...group, itemKeys: ['codex:thread:local:old', 'codex:thread:local:unrelated'] },
    ]);
    const before = structuredClone(current);
    assert.deepEqual(codexResetPlacement(current, 'new').request, {
      tool: 'move_thread_to_sidebar_section',
      arguments: { threadId: 'new', hostId: 'local', source: 'codex', sectionId: 'owned-group' },
    });
    assert.deepEqual(current, before);
    assert.deepEqual(
      codexResetPlacement(inventory([{ ...group, itemKeys: ['codex:thread:local:new'] }]), 'new'),
      { status: 'done' },
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
      const result = codexResetPlacement(value, 'new');
      assert.equal(result.code, 'notification-reset-native-inventory-required');
      assert.equal(result.request, undefined);
    }
    assert.equal(
      codexResetPlacement(inventory([group, { ...group, sectionId: 'duplicate' }]), 'new').code,
      'notification-reset-sidebar-ambiguous',
    );
  });
});
