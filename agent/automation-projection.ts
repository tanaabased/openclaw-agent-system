import { AutomationError, type NativeAutomation } from './automation-gateway.ts';
import { automationHash, type AutomationRecord } from './automation-store.ts';
import automationContent from '../manifest/automation-content.ts';
import type { ResolvedAutomation } from '../manifest/automation-schema.ts';

export interface AutomationProjectionContext {
  agentId: string;
  workspaceDir: string;
  command: string[];
  environment: Record<string, string>;
  timezone: string;
}
export type NativeAutomationSpec = Record<string, unknown> & {
  enabled: boolean;
  schedule: Record<string, unknown>;
  payload: Record<string, unknown>;
};

export function effectiveAutomation(job: ResolvedAutomation, context: AutomationProjectionContext) {
  const override = job.overrides.openclaw;
  if (job.payload.kind === 'prompt' && override?.target && override.target !== 'independent') {
    // named targets require an existing-session ownership contract; never create or infer one.
    throw new AutomationError('automation-target-unsupported');
  }
  if (
    override?.effort &&
    !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive'].includes(override.effort)
  ) {
    throw new AutomationError('automation-effort-unsupported');
  }
  const normalized = automationContent(job, 'openclaw');
  return { ...normalized, hash: automationHash({ content: normalized.content, context }) };
}

export function projectAutomation(
  job: ResolvedAutomation,
  record: AutomationRecord,
  context: AutomationProjectionContext,
): NativeAutomationSpec {
  const effective = effectiveAutomation(job, context);
  const schedule = job.schedule;
  const nativeSchedule =
    schedule.kind === 'every'
      ? { kind: 'every', everyMs: schedule.seconds * 1000, anchorMs: record.anchorMs }
      : schedule.kind === 'in' || schedule.kind === 'at'
        ? {
            kind: 'at',
            at:
              schedule.kind === 'at'
                ? schedule.at
                : new Date(record.anchorMs + schedule.seconds * 1000).toISOString(),
          }
        : schedule.kind === 'cron'
          ? {
              kind: 'cron',
              expr: [
                schedule.fields.minutes.join(','),
                schedule.fields.hours.join(','),
                schedule.fields.dayWildcard ? '*' : schedule.fields.days.join(','),
                schedule.fields.months.join(','),
                schedule.fields.weekdayWildcard ? '*' : schedule.fields.weekdays.join(','),
              ].join(' '),
              tz: schedule.timezone === 'native' ? context.timezone : schedule.timezone,
              staggerMs: 0,
            }
          : (() => {
              throw new AutomationError('automation-schedule-unsupported');
            })();
  const timeoutSeconds = Number(effective.content.timeoutSeconds);
  const override = job.overrides.openclaw;
  return {
    name: `Agent System: ${job.id}`,
    declarationKey: record.marker,
    agentId: context.agentId,
    enabled: job.enabled,
    deleteAfterRun: false,
    schedule: nativeSchedule,
    sessionTarget: 'isolated',
    wakeMode: 'now',
    delivery: { mode: 'none', bestEffort: false },
    failureAlert: false,
    payload:
      job.payload.kind === 'command'
        ? {
            kind: 'command',
            argv: [
              ...context.command,
              'agent-system',
              'automation-execute',
              '--id',
              job.id,
              '--hash',
              effective.hash,
            ],
            cwd: context.workspaceDir,
            env: context.environment,
            input: '',
            timeoutSeconds,
            noOutputTimeoutSeconds: 3600,
            outputMaxBytes: 16384,
          }
        : {
            kind: 'agentTurn',
            message: job.payload.prompt.trim(),
            timeoutSeconds,
            lightContext: false,
            allowUnsafeExternalContent: false,
            toolsAllow: ['*'],
            ...(override?.model ? { model: override.model.trim() } : {}),
            ...(override?.effort ? { thinking: override.effort.trim() } : {}),
          },
  };
}

/** compare owned executable settings, excluding native clocks, history and creator provenance. */
export function nativeAutomationHash(job: Record<string, unknown>): string {
  return automationHash(
    Object.fromEntries(
      [
        'name',
        'declarationKey',
        'agentId',
        'enabled',
        'deleteAfterRun',
        'schedule',
        'sessionTarget',
        'sessionKey',
        'wakeMode',
        'payload',
        'delivery',
        'failureAlert',
        'trigger',
        'pacing',
      ]
        .filter((key) => job[key] !== undefined && job[key] !== null)
        .map((key) => [key, job[key]]),
    ),
  );
}

export function retainedOneShot(job: NativeAutomation): boolean {
  return (
    job.schedule.kind === 'at' &&
    typeof job.state.lastRunAtMs === 'number' &&
    ['ok', 'skipped'].includes(String(job.state.lastRunStatus ?? job.state.lastStatus)) &&
    job.state.nextRunAtMs === undefined
  );
}

/** omit unchanged scheduling fields; native update treats their presence as a scheduling edit. */
export function automationPatch(
  current: NativeAutomation,
  desired: NativeAutomationSpec,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (automationHash(current[key] ?? null) !== automationHash(value)) patch[key] = value;
  }
  if (patch.payload && desired.payload.kind === 'agentTurn') {
    patch.payload = {
      ...desired.payload,
      model: desired.payload.model ?? null,
      thinking: desired.payload.thinking ?? null,
      fallbacks: null,
      toolsAllow: desired.payload.toolsAllow,
    };
  } else if (patch.payload) patch.payload = { ...desired.payload, toolsAllow: null };
  if (patch.delivery) {
    patch.delivery = {
      ...(desired.delivery as object),
      channel: null,
      to: null,
      threadId: null,
      accountId: null,
      completionDestination: null,
      failureDestination: null,
    };
  }
  for (const key of ['sessionKey', 'trigger', 'pacing'])
    if (current[key] !== undefined) patch[key] = null;
  return patch;
}
