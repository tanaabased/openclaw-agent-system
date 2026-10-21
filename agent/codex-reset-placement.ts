import { nativeObject } from './automation-gateway.ts';
import type { NotificationResetEffect } from './notification-reset.ts';

export default function codexResetPlacement(
  inventory: unknown,
  threadId: string,
): NotificationResetEffect {
  if (
    !nativeObject(inventory) ||
    inventory.schemaVersion !== 4 ||
    !Array.isArray(inventory.sections) ||
    !Array.isArray(inventory.unavailableHosts) ||
    inventory.unavailableHosts.includes('local') ||
    !Array.isArray(inventory.unavailableSources) ||
    inventory.unavailableSources.includes('codex') ||
    inventory.sections.some(
      (section) =>
        !nativeObject(section) ||
        typeof section.sectionId !== 'string' ||
        !section.sectionId ||
        typeof section.name !== 'string' ||
        !Array.isArray(section.itemKeys) ||
        section.itemKeys.some((key) => typeof key !== 'string'),
    )
  )
    return {
      status: 'incomplete',
      code: 'notification-reset-native-inventory-required',
      instruction:
        'read native list_threads and supply its complete result as nativeInventory to verify replacement coordinator placement',
    };
  const sections = inventory.sections.filter((section) => section.name === 'AGENT SYSTEM');
  if (sections.length > 1)
    return {
      status: 'incomplete',
      code: 'notification-reset-sidebar-ambiguous',
      instruction: 'resolve duplicate AGENT SYSTEM sidebar sections, then refresh nativeInventory',
    };
  const section = sections[0];
  if (section?.itemKeys.includes(`codex:thread:local:${threadId}`)) return { status: 'done' };
  return {
    status: 'native-action',
    request: section
      ? {
          tool: 'move_thread_to_sidebar_section',
          arguments: { threadId, hostId: 'local', source: 'codex', sectionId: section.sectionId },
        }
      : { tool: 'create_sidebar_section', arguments: { name: 'AGENT SYSTEM' } },
    instruction:
      'execute this native sidebar action once, then refresh list_threads and repeat the same reset with its complete result as nativeInventory; preserve the workspace binding',
  };
}
