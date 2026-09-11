import type { CliLifecycleLine, CliSummaryLine } from '../cli/output.ts';
import type { AgentSystemLifecycleFinding } from './lifecycle-registry.ts';

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

/** Assign independent emphasis roles for the Doctor and Install table cells. */
export function lifecycleTableLines(
  items: readonly AgentSystemLifecyclePresentationItem[],
): CliLifecycleLine[] {
  return items.map(({ component, message, status }) => ({
    attention: ['blocked', 'drift', 'warning', 'manual'].includes(status),
    component,
    label: status,
    quiet: status === 'healthy' || status === 'unchanged',
    style: presentationStyle(status),
    value: message,
  }));
}

/** Group a display copy without changing findings, aggregate status, or execution order. */
export function orderDoctorFindings(
  findings: readonly AgentSystemLifecycleFinding[],
): AgentSystemLifecycleFinding[] {
  const priority = ({ status }: AgentSystemLifecycleFinding) =>
    status === 'blocked' ? 0 : status === 'healthy' ? 2 : 1;
  return [...findings].sort((left, right) => priority(left) - priority(right));
}
