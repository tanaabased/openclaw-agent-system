import { AutomationError } from './automation-errors.ts';
import { automationHash } from '../automation-hash.ts';
import type { AutomationRuntime, ResolvedAutomation } from '../../manifest/automation-schema.ts';
import managedGroupName, { defaultManagedGroup } from '../../utils/managed-group-name.ts';

export interface AutomationThreadSelection {
  key: string;
  exact?: string;
  name?: string;
  managed: boolean;
  group?: string;
}

/** titles never identify conversations; Codex partitions shared declarations by stable job identity. */
export function automationThreadSelection(
  job: ResolvedAutomation,
  runtime: AutomationRuntime,
): AutomationThreadSelection | undefined {
  if (job.payload.kind === 'command' && runtime !== 'openclaw') return;
  const target = job.overrides[runtime]?.target;
  if (target === 'independent') return;
  const group = managedGroupName(
    job.group ?? defaultManagedGroup,
    runtime === 'openclaw' ? 512 : undefined,
  );
  if (target)
    return {
      key: automationHash(['native', target.thread]),
      exact: target.thread,
      managed: false,
      group,
    };
  if (!job.thread) return;
  return {
    key: automationHash(
      job.thread.id
        ? runtime === 'openclaw'
          ? ['shared', job.thread.id]
          : ['shared', job.thread.id, job.id]
        : ['job', job.id],
    ),
    ...(job.thread.id ? { exact: job.thread.id } : {}),
    ...(job.thread.name ? { name: job.thread.name } : {}),
    managed: true,
    group,
  };
}

export function automationThreadNames(jobs: ResolvedAutomation[], runtime: AutomationRuntime) {
  const names = new Map<string, string>();
  for (const job of jobs.filter((job) => job.runtimes.includes(runtime))) {
    const selection = automationThreadSelection(job, runtime);
    if (!selection?.name) continue;
    const previous = names.get(selection.key);
    if (previous !== undefined && previous !== selection.name) {
      const error = new AutomationError('automation-thread-name-conflict');
      error.automationId = job.id;
      throw error;
    }
    names.set(selection.key, selection.name);
  }
  return names;
}
