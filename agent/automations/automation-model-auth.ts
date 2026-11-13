import { AutomationError } from './automation-errors.ts';
import { nativeObject, type AutomationGateway } from './automation-gateway.ts';
import type { ResolvedAutomation } from '../../manifest/automation-schema.ts';

/** use native route-aware evidence; unknown availability is never credential absence. */
export default async function automationModelAuth(
  request: AutomationGateway,
  agentId: string,
  jobs: readonly ResolvedAutomation[],
): Promise<Set<string>> {
  const prompts = jobs.filter((job) => job.payload.kind === 'prompt');
  if (!prompts.length) return new Set();
  const result = await request('models.list', {
    agentId,
    view: 'all',
    preparedOnly: true,
    includeDefaultModels: false,
  });
  if (!Array.isArray(result.models) || result.models.some((row) => !nativeObject(row)))
    throw new AutomationError('automation-model-evidence-unavailable');
  const rows = result.models as Record<string, unknown>[];
  return new Set(
    prompts
      .filter((job) => {
        const model = job.overrides.openclaw?.model;
        const matches = rows.filter((row) =>
          model
            ? `${row.provider}/${row.id}` === model
            : Array.isArray(row.tags) && row.tags.includes('default'),
        );
        return (
          matches.length === 1 &&
          matches[0]!.available === false &&
          matches[0]!.unavailableReason === 'missing-auth'
        );
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
