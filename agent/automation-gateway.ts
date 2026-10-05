import type { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

export type AutomationGateway = (
  method:
    | 'sessions.resolve'
    | 'sessions.list'
    | 'sessions.create'
    | 'sessions.patch'
    | 'cron.list'
    | 'cron.get'
    | 'cron.add'
    | 'cron.update'
    | 'cron.status'
    | 'cron.run'
    | 'cron.runs',
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export class AutomationError extends Error {
  constructor(readonly code: string) {
    super(`Automation operation failed (${code}).`);
  }
}

export function nativeObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** admission is not execution completion; retain only bounded non-secret result fields. */
export function nativeAutomationRun(value: unknown) {
  if (!nativeObject(value) || value.ok !== true)
    throw new AutomationError('automation-native-response-invalid');
  if (value.enqueued === true) {
    if (typeof value.runId !== 'string' || !value.runId.trim())
      throw new AutomationError('automation-native-response-invalid');
    return { status: 'queued' as const, runId: value.runId };
  }
  if (
    value.ran !== false ||
    !['already-running', 'not-due', 'disabled', 'invalid-spec', 'stopped'].includes(
      String(value.reason),
    )
  )
    throw new AutomationError('automation-native-response-invalid');
  return { status: 'skipped' as const, reason: String(value.reason) };
}

export interface AutomationHistoryOptions {
  limit: number;
  offset: number;
  runId?: string;
}

/** raw model output and provider errors do not belong in the operator status envelope. */
export function nativeAutomationHistory(
  value: unknown,
  nativeId: string,
  options: AutomationHistoryOptions,
) {
  if (
    !nativeObject(value) ||
    !Array.isArray(value.entries) ||
    !Number.isSafeInteger(value.total) ||
    Number(value.total) < 0 ||
    value.offset !== Math.min(options.offset, Number(value.total)) ||
    value.limit !== options.limit ||
    typeof value.hasMore !== 'boolean' ||
    value.entries.length > options.limit
  )
    throw new AutomationError('automation-native-response-invalid');
  const entries = value.entries.map((entry: unknown) => {
    if (
      !nativeObject(entry) ||
      entry.jobId !== nativeId ||
      entry.action !== 'finished' ||
      !Number.isSafeInteger(entry.ts) ||
      Number(entry.ts) < 0 ||
      (entry.status !== undefined && !['ok', 'error', 'skipped'].includes(String(entry.status))) ||
      (entry.deliveryStatus !== undefined &&
        !['delivered', 'not-delivered', 'unknown', 'not-requested'].includes(
          String(entry.deliveryStatus),
        )) ||
      (entry.runId !== undefined && (typeof entry.runId !== 'string' || !entry.runId.trim())) ||
      (options.runId !== undefined && entry.runId !== options.runId)
    )
      throw new AutomationError('automation-native-response-invalid');
    return {
      ts: Number(entry.ts),
      ...(typeof entry.runId === 'string' ? { runId: entry.runId } : {}),
      execution: entry.status ?? 'unavailable',
      delivery: entry.deliveryStatus ?? 'unavailable',
    };
  });
  const offset = Number(value.offset);
  if (
    value.hasMore !== offset + entries.length < Number(value.total) ||
    (value.hasMore
      ? value.nextOffset !== offset + entries.length || entries.length !== options.limit
      : value.nextOffset !== null)
  )
    throw new AutomationError('automation-native-response-invalid');
  return {
    entries,
    total: Number(value.total),
    offset,
    limit: options.limit,
    hasMore: value.hasMore,
    nextOffset: value.hasMore ? Number(value.nextOffset) : null,
  };
}

export type AutomationGatewayCaller = typeof callGatewayFromCli;

/** operator transport; only the admitted cli composition supplies this dependency. */
export function createAutomationGateway(call: AutomationGatewayCaller): AutomationGateway {
  return async (method, params) => {
    const readOnly = ![
      'cron.add',
      'cron.update',
      'cron.run',
      'sessions.create',
      'sessions.patch',
    ].includes(method);
    try {
      return await call(method, { timeout: '10000' }, params, {
        progress: false,
        scopes: [readOnly ? 'operator.read' : 'operator.admin'],
        ...(readOnly ? { sharedStateMode: 'read-only' as const } : {}),
      });
    } catch {
      throw new AutomationError('automation-gateway-unavailable');
    }
  };
}

export const requestAutomationGateway: AutomationGateway = async (method, params) => {
  const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
  return createAutomationGateway(callGatewayFromCli)(method, params);
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
    !nativeObject(value) ||
    typeof job.id !== 'string' ||
    !job.id ||
    typeof job.configRevision !== 'string' ||
    !job.configRevision ||
    typeof job.enabled !== 'boolean' ||
    !nativeObject(job.schedule) ||
    !nativeObject(job.payload) ||
    !nativeObject(job.state)
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
    if (!nativeObject(page) || !Array.isArray(page.jobs) || typeof page.hasMore !== 'boolean') {
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
