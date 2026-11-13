import automationCompatibilityDiagnostic from './automation-compatibility-diagnostic.ts';
import { AutomationError } from './automation-errors.ts';
import { nativeObject } from '../../utils/native-object.ts';
import { type AutomationGateway } from './automation-gateway.ts';
import type { ResolvedAutomation } from '../../manifest/automation-schema.ts';

export type ModelUnavailableReason =
  'missing-auth' | 'auth-failed' | 'cooldown' | 'unavailable' | 'unresolved';

/** Failed reads are errors; unresolved catalog readiness is not proof of missing auth. */
export default async function automationModelAuth(
  request: AutomationGateway,
  agentId: string,
  jobs: readonly ResolvedAutomation[],
  mode: 'inspect' | 'reconcile' = 'inspect',
): Promise<Map<string, ModelUnavailableReason>> {
  const prompts = jobs.filter((job) => job.payload.kind === 'prompt');
  if (!prompts.length) return new Map();
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
  const unresolved = () =>
    prompts.some((job) => {
      const row = selected(job);
      return row && typeof row.available !== 'boolean';
    });
  if (mode === 'reconcile' && unresolved()) rows = await readRows(true);
  // Remaining unknown evidence is left to cron's authoritative scheduled-auth check.
  const unavailable = new Map<string, ModelUnavailableReason>();
  for (const job of prompts) {
    const row = selected(job);
    automationCompatibilityDiagnostic('automation-model-evidence', {
      mode,
      automationId: job.id,
      model: job.overrides.openclaw?.model ?? 'default',
      selected: Boolean(row),
      availability:
        row?.available === true
          ? 'available'
          : row?.available === false
            ? 'unavailable'
            : 'unknown',
      reason: ['missing-auth', 'auth-failed', 'cooldown'].includes(String(row?.unavailableReason))
        ? row!.unavailableReason
        : 'unspecified',
    });
    if (row && typeof row.available !== 'boolean' && mode === 'inspect') {
      unavailable.set(job.id, 'unresolved');
      continue;
    }
    if (row?.available !== false) continue;
    const reason = row.unavailableReason;
    unavailable.set(
      job.id,
      reason === 'missing-auth' || reason === 'auth-failed' || reason === 'cooldown'
        ? reason
        : 'unavailable',
    );
  }
  return unavailable;
}

export function automationModelUnavailableCode(reason: ModelUnavailableReason) {
  if (reason === 'unresolved') return 'automation-model-readiness-unresolved';
  return reason === 'missing-auth'
    ? 'automation-model-auth-missing'
    : 'automation-model-unavailable';
}

export function automationModelSkipped(id: string, reason: ModelUnavailableReason) {
  return {
    component: 'automations',
    stepId: id,
    status: 'skipped' as const,
    code: automationModelUnavailableCode(reason),
    message:
      reason === 'unresolved'
        ? `Automation ${id} is not installed and its model availability is unresolved. Run Install to check scheduled authentication; inspection did not attempt enrollment.`
        : reason === 'missing-auth'
          ? `Automation ${id} was not installed because its model authentication is not configured. Configure authentication, then rerun Install.`
          : `Automation ${id} was not installed because OpenClaw reports its model unavailable (${reason}). Resolve model availability, then rerun Install.`,
  };
}
