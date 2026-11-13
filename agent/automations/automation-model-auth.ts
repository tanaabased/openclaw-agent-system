import { AutomationError } from './automation-errors.ts';
import { nativeObject, type AutomationGateway } from './automation-gateway.ts';
import type { ResolvedAutomation } from '../../manifest/automation-schema.ts';

/** use native route-aware evidence; unknown availability is never credential absence. */
export default async function automationModelAuth(
  request: AutomationGateway,
  agentId: string,
  jobs: readonly ResolvedAutomation[],
  mode: 'inspect' | 'reconcile' = 'inspect',
): Promise<Set<string>> {
  const prompts = jobs.filter((job) => job.payload.kind === 'prompt');
  if (!prompts.length) return new Set();
  const params = {
    agentId,
    view: 'all',
    includeDefaultModels: false,
  };
  const readRows = async (acquire: boolean) => {
    const result = await request('models.list', {
      ...params,
      ...(acquire ? { refresh: true } : { preparedOnly: true }),
    });
    if (!Array.isArray(result.models) || result.models.some((row) => !nativeObject(row)))
      throw new AutomationError('automation-model-evidence-unavailable');
    return result.models as Record<string, unknown>[];
  };
  let rows = await readRows(false);
  const selected = (job: ResolvedAutomation) => {
    const model = job.overrides.openclaw?.model;
    const matches = rows.filter((row) =>
      model
        ? `${row.provider}/${row.id}` === model
        : Array.isArray(row.tags) && row.tags.includes('default'),
    );
    return matches.length === 1 ? matches[0] : undefined;
  };
  // Prepared Codex inventory can omit native auth evidence. Only reconciliation may
  // acquire the native catalog; inspection must not initiate provider discovery.
  if (
    mode === 'reconcile' &&
    prompts.some((job) => {
      const row = selected(job);
      return row && typeof row.available !== 'boolean';
    })
  )
    rows = await readRows(true);
  return new Set(
    prompts
      .filter((job) => {
        const row = selected(job);
        return row?.available === false && row.unavailableReason === 'missing-auth';
      })
      .map(({ id }) => id),
  );
}

export function automationAuthSkipped(id: string) {
  return {
    component: 'automations',
    stepId: id,
    status: 'skipped' as const,
    code: 'automation-model-auth-missing',
    message: `Automation ${id} was not installed because its model authentication is not configured. Configure authentication, then rerun Install.`,
  };
}
