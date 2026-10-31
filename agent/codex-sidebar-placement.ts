import managedGroupName, { defaultManagedGroup } from '../utils/managed-group-name.ts';
import { nativeObject } from './automation-gateway.ts';

export interface SidebarSection {
  sectionId: string;
  name: string;
  itemKeys: string[];
}
export type SidebarAction =
  | { tool: 'create_sidebar_section'; arguments: { name: string } }
  | {
      tool: 'move_thread_to_sidebar_section';
      arguments: { threadId: string; hostId: 'local'; source: 'codex'; sectionId: string };
    };

export function sidebarSections(inventory: unknown): SidebarSection[] {
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
    throw new Error('automation-sidebar-inventory-required');
  const sections = inventory.sections as SidebarSection[];
  if (new Set(sections.map(({ sectionId }) => sectionId)).size !== sections.length)
    throw new Error('automation-sidebar-inventory-required');
  return sections;
}

/** exact native ids and names only; differently cased sections are unrelated. */
export default function codexSidebarPlacement(
  inventory: unknown,
  threadId: string,
  desired = defaultManagedGroup,
  retainedId?: string,
): { sectionId?: string; request?: SidebarAction } {
  const name = managedGroupName(desired);
  const matches = sidebarSections(inventory).filter((section) => section.name === name);
  const retained = matches.find((section) => section.sectionId === retainedId);
  if (matches.length > 1 && !retained) throw new Error('automation-sidebar-ambiguous');
  const section = retained ?? matches[0];
  if (!section) return { request: { tool: 'create_sidebar_section', arguments: { name } } };
  const sectionId = section.sectionId;
  if (section.itemKeys.includes(`codex:thread:local:${threadId}`)) return { sectionId };
  return {
    sectionId,
    request: {
      tool: 'move_thread_to_sidebar_section',
      arguments: { threadId, hostId: 'local', source: 'codex', sectionId },
    },
  };
}
