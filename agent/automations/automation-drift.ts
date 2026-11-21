import { nativeObject } from '../../utils/native-object.ts';
import type { ResolvedAutomation } from '../../manifest/automation-schema.ts';
import type { NativeAutomation } from './automation-gateway.ts';
import {
  effectiveAutomation,
  nativeAutomationHash,
  projectAutomation,
  retainedOneShot,
  type AutomationProjectionContext,
} from './automation-projection.ts';
import { automationHash, type AutomationRecord } from './automation-store.ts';
import { automationThreadSelection } from './automation-thread-selection.ts';

function installedCommandContext(
  job: ResolvedAutomation,
  context: AutomationProjectionContext,
  { payload, schedule }: Pick<NativeAutomation, 'payload' | 'schedule'>,
  hash: string,
): AutomationProjectionContext | undefined {
  if (job.origin === 'builtin' || payload.kind !== 'command') return;

  // compare using verified installed launcher inputs, not incidental runner settings.
  const { argv, env } = payload;
  if (
    !Array.isArray(argv) ||
    !argv.every((value): value is string => typeof value === 'string') ||
    argv.length <= 6 ||
    automationHash(argv.slice(-6)) !==
      automationHash(['agent-system', 'automation-execute', '--id', job.id, '--hash', hash])
  )
    return;
  const environment = env ?? {};
  if (
    !nativeObject(environment) ||
    Object.values(environment).some((value) => typeof value !== 'string')
  )
    return;
  const installedContext = {
    ...context,
    command: argv.slice(0, -6),
    environment: environment as Record<string, string>,
  };
  if (effectiveAutomation(job, installedContext).hash === hash) return installedContext;
  if (typeof schedule.tz === 'string') {
    const scheduledContext = { ...installedContext, timezone: schedule.tz };
    if (effectiveAutomation(job, scheduledContext).hash === hash) return scheduledContext;
  }
}

export function commandConfigurationMatches(
  job: ResolvedAutomation,
  context: AutomationProjectionContext,
  native: NativeAutomation,
  hash: string,
): boolean {
  return (
    effectiveAutomation(job, context).hash === hash ||
    installedCommandContext(job, context, native, hash) !== undefined
  );
}

/** compare the desired reconciliation projection without making a launch decision. */
export function automationReconciliationState(
  job: ResolvedAutomation,
  context: AutomationProjectionContext,
  record: AutomationRecord,
  native: Record<string, unknown>,
): 'aligned' | 'drift' | 'recovery' {
  const { payload, schedule, state } = native;
  if (
    !record.nativeHash ||
    record.pending ||
    record.retired ||
    !nativeObject(payload) ||
    !nativeObject(schedule) ||
    (nativeObject(state) && state.autoDisabled)
  )
    return 'recovery';

  const observedHash = nativeAutomationHash(native);
  const verified = observedHash === record.nativeHash;
  // the reader may run under a different host timezone than the installer.
  const projectionContext =
    verified && record.projectionTimezone
      ? { ...context, timezone: record.projectionTimezone }
      : context;
  const normalized =
    (verified &&
      installedCommandContext(job, projectionContext, { payload, schedule }, record.hash)) ||
    projectionContext;
  const selection = automationThreadSelection(job, 'openclaw');
  const savedTarget =
    verified &&
    typeof native.sessionTarget === 'string' &&
    native.sessionTarget.startsWith('session:')
      ? native.sessionTarget.slice(8)
      : undefined;
  const target = normalized.threads
    ? normalized.threads.get(job.id)?.id
    : selection
      ? selection.managed
        ? (savedTarget ?? selection.exact)
        : selection.exact
      : undefined;
  const desiredContext = {
    ...normalized,
    threads: target ? new Map([[job.id, { id: target, outcome: 'observed' }]]) : undefined,
  };
  const effective = effectiveAutomation(job, desiredContext);
  const desired = projectAutomation(job, record, desiredContext, { payload });
  if (
    nativeObject(state) &&
    retainedOneShot({ schedule, state }) &&
    record.triggerHash === effective.triggerHash
  )
    desired.enabled = false;

  if (
    record.removed ||
    record.hash !== effective.hash ||
    observedHash !== nativeAutomationHash(desired)
  )
    return 'drift';
  return verified ? 'aligned' : 'recovery';
}
