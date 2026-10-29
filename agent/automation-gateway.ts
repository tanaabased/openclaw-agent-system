import type { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';

import {
  assertPrivateStateLocksHeld,
  privateStateLockSignal,
} from '../core/private-state-lock-context.ts';
import type { AutomationGatewayDiagnostic } from './automation-gateway-diagnostic.ts';
import { openclawSessionCreateTimeoutMs } from './openclaw-session-timeout.ts';

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
  constructor(
    readonly code: string,
    readonly diagnostic?: AutomationGatewayDiagnostic,
  ) {
    super(
      `Automation operation failed (${code}).` +
        (diagnostic?.reason ? ` ${diagnostic.method}: ${diagnostic.reason}.` : ''),
    );
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

const operatorGateways = new WeakSet<AutomationGateway>();

/** operator origin alone does not prove completeness; also compare native aggregate counts. */
export function isOperatorAutomationGateway(request: AutomationGateway): boolean {
  return operatorGateways.has(request);
}

/** operator transport; only the admitted cli composition supplies this dependency. */
export function createAutomationGateway(call: AutomationGatewayCaller): AutomationGateway {
  const request: AutomationGateway = async (method, params) => {
    assertPrivateStateLocksHeld();
    const readOnly = ![
      'cron.add',
      'cron.update',
      'cron.run',
      'sessions.create',
      'sessions.patch',
    ].includes(method);
    const signal = method === 'sessions.create' ? privateStateLockSignal() : undefined;
    try {
      return await call(
        method,
        method === 'sessions.create' ? { timeout: String(openclawSessionCreateTimeoutMs) } : {},
        params,
        {
          progress: false,
          ...(signal ? { signal } : {}),
          // session-only authority prevents native sticky model policy from changing config.
          scopes: [
            readOnly
              ? 'operator.read'
              : method.startsWith('sessions.')
                ? 'operator.write'
                : 'operator.admin',
          ],
          ...(readOnly ? { sharedStateMode: 'read-only' as const } : {}),
        },
      );
    } catch (error) {
      const { default: automationGatewayDiagnostic } =
        await import('./automation-gateway-diagnostic.ts');
      const { default: automationGatewayUnavailable } =
        await import('./automation-gateway-unavailable.ts');
      const diagnostic = automationGatewayDiagnostic(method, error);
      throw new AutomationError(
        automationGatewayUnavailable(error)
          ? 'automation-gateway-unavailable'
          : diagnostic.category === 'rejected'
            ? 'automation-gateway-rejected'
            : 'automation-gateway-failed',
        diagnostic,
      );
    }
  };
  operatorGateways.add(request);
  return request;
}

export const requestAutomationGateway: AutomationGateway = async (method, params) => {
  const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
  return createAutomationGateway(callGatewayFromCli)(method, params);
};
operatorGateways.add(requestAutomationGateway);

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
  options: { requireComplete?: boolean } = {},
): Promise<NativeAutomation[]> {
  if (options.requireComplete && !isOperatorAutomationGateway(request))
    throw new AutomationError('automation-inspection-incomplete');
  const before = options.requireComplete ? await request('cron.status', {}) : undefined;
  const jobs: NativeAutomation[] = [];
  let total: number | undefined;
  for (let offset = 0; offset < 10_000; offset += 200) {
    const page = await request('cron.list', {
      includeDisabled: true,
      limit: 200,
      offset,
      includeDeliveryPreviews: false,
    });
    if (
      !nativeObject(page) ||
      !Array.isArray(page.jobs) ||
      page.jobs.length > 200 ||
      typeof page.hasMore !== 'boolean'
    ) {
      throw new AutomationError('automation-native-response-invalid');
    }
    if (
      (page.offset !== undefined && page.offset !== offset) ||
      (page.limit !== undefined && page.limit !== 200) ||
      (page.total !== undefined &&
        (!Number.isSafeInteger(page.total) ||
          Number(page.total) < 0 ||
          (total !== undefined && page.total !== total))) ||
      (page.nextOffset !== undefined &&
        page.nextOffset !== (page.hasMore ? offset + page.jobs.length : null))
    )
      throw new AutomationError('automation-native-snapshot-diverged');
    if (page.total !== undefined) total = Number(page.total);
    jobs.push(...page.jobs.map(nativeAutomation));
    if (total !== undefined && (page.hasMore ? jobs.length >= total : jobs.length !== total))
      throw new AutomationError('automation-native-snapshot-diverged');
    if (!page.hasMore) {
      if (new Set(jobs.map(({ id }) => id)).size !== jobs.length) {
        throw new AutomationError('automation-native-snapshot-diverged');
      }
      if (options.requireComplete) {
        // native status counts all retained jobs, independently of list visibility filters.
        const after = await request('cron.status', {});
        if (
          !Number.isSafeInteger(before?.jobs) ||
          before?.jobs !== jobs.length ||
          after.jobs !== before.jobs
        )
          throw new AutomationError('automation-inspection-incomplete');
      }
      return jobs;
    }
    if (page.jobs.length !== 200) throw new AutomationError('automation-native-snapshot-diverged');
  }
  throw new AutomationError('automation-native-list-limit');
}
