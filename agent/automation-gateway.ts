export type AutomationGateway = (
  method: 'cron.list' | 'cron.get' | 'cron.add' | 'cron.update' | 'cron.status',
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export class AutomationError extends Error {
  constructor(readonly code: string) {
    super(`Automation operation failed (${code}).`);
  }
}

/** operator transport; only the admitted cli composition supplies this dependency. */
export const requestAutomationGateway: AutomationGateway = async (method, params) => {
  const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
  const readOnly = !['cron.add', 'cron.update'].includes(method);
  try {
    return await callGatewayFromCli(method, { timeout: '10000' }, params, {
      progress: false,
      scopes: [readOnly ? 'operator.read' : 'operator.admin'],
      ...(readOnly ? { sharedStateMode: 'read-only' as const } : {}),
    });
  } catch {
    throw new AutomationError('automation-gateway-unavailable');
  }
};

export interface NativeAutomation extends Record<string, unknown> {
  id: string;
  declarationKey: string;
  agentId: string;
  enabled: boolean;
  configRevision: string;
  schedule: Record<string, unknown>;
  payload: Record<string, unknown>;
  state: Record<string, unknown>;
}

export function nativeAutomation(value: unknown): NativeAutomation {
  const job = value as NativeAutomation | undefined;
  if (
    !job ||
    typeof job.id !== 'string' ||
    typeof job.configRevision !== 'string' ||
    typeof job.enabled !== 'boolean' ||
    !job.schedule ||
    !job.payload ||
    !job.state ||
    typeof job.schedule !== 'object' ||
    typeof job.payload !== 'object' ||
    typeof job.state !== 'object'
  ) {
    throw new AutomationError('automation-native-response-invalid');
  }
  return job;
}

/** bounded pagination includes retained disabled jobs; never interpret a bad response as empty. */
export async function listNativeAutomations(
  request: AutomationGateway,
): Promise<NativeAutomation[]> {
  const jobs: NativeAutomation[] = [];
  for (let offset = 0; offset < 10_000; offset += 200) {
    const page = await request('cron.list', {
      includeDisabled: true,
      limit: 200,
      offset,
      includeDeliveryPreviews: false,
    });
    if (!Array.isArray(page.jobs) || typeof page.hasMore !== 'boolean') {
      throw new AutomationError('automation-native-response-invalid');
    }
    jobs.push(...page.jobs.map(nativeAutomation));
    if (!page.hasMore) {
      if (new Set(jobs.map(({ id }) => id)).size !== jobs.length) {
        throw new AutomationError('automation-native-snapshot-diverged');
      }
      return jobs;
    }
    if (page.jobs.length !== 200) throw new AutomationError('automation-native-snapshot-diverged');
  }
  throw new AutomationError('automation-native-list-limit');
}
