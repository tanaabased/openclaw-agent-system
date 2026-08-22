import type { CliSummaryLine } from '../cli/output.ts';

export type AgentSystemLifecyclePresentationStatus =
  | 'blocked'
  | 'created'
  | 'drift'
  | 'healthy'
  | 'manual'
  | 'removed'
  | 'unchanged'
  | 'updated'
  | 'valid'
  | 'warning';

export interface AgentSystemLifecyclePresentationItem {
  component: string;
  message: string;
  status: AgentSystemLifecyclePresentationStatus;
}

function presentationStyle(
  status: AgentSystemLifecyclePresentationStatus,
): CliSummaryLine['style'] {
  if (status === 'healthy' || status === 'unchanged' || status === 'valid') return 'status';
  if (status === 'blocked') return 'error';
  if (status === 'drift' || status === 'warning') return 'warning';
  if (status === 'created' || status === 'removed' || status === 'updated') {
    return 'action';
  }
  return 'field';
}

/** Convert lifecycle results into the shared component-aware CLI summary shape. */
export default function lifecyclePresentationLines(
  items: readonly AgentSystemLifecyclePresentationItem[],
): CliSummaryLine[] {
  return items.map(({ component, message, status }) => ({
    component,
    label: status,
    style: presentationStyle(status),
    value: message,
  }));
}
