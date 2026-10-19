import type { OpenClawPluginServiceContext } from 'openclaw/plugin-sdk/plugin-entry';

import type AutomationService from './automation-service.ts';
import { listNativeAutomations, type AutomationGateway } from './automation-gateway.ts';
import { effectiveAutomation, nativeAutomationHash } from './automation-projection.ts';
import openclawIntakeJobs, { openclawIntakeAutomationId } from './openclaw-intake-policy.ts';
import type { AgentManifest } from '../manifest/types.ts';

export type NotificationScheduler = Pick<
  NonNullable<ReturnType<NonNullable<OpenClawPluginServiceContext['getCron']>>>,
  'list' | 'isEnabled'
>;

/** observe the installed projection without credentials, session RPCs, or scheduler mutations. */
export default async function notificationAutomationReadiness(
  service: Pick<AutomationService, 'scope'>,
  manifest: AgentManifest,
  workspace: string,
  scheduler?: NotificationScheduler,
  request?: AutomationGateway,
): Promise<string | undefined> {
  const { context, store } = await service.scope(manifest, workspace);
  const declared = openclawIntakeJobs(manifest).find(({ id }) => id === openclawIntakeAutomationId);
  if (!declared) return 'intake-policy-disabled';
  const record = (await store.read()).records.find(({ id }) => id === declared.id);
  if (!record) return 'intake-activation-required';
  if (record.removed || record.pending || !record.nativeId || !record.nativeHash)
    return 'intake-automation-update-required';
  if (record.hash !== effectiveAutomation(declared, context).hash) {
    const legacy = openclawIntakeJobs(manifest, true).find(({ id }) => id === declared.id);
    if (!legacy || record.hash !== effectiveAutomation(legacy, context).hash)
      return 'intake-automation-update-required';
  }
  if (!scheduler && !request) return 'automation-observation-unavailable';
  const enabled = scheduler
    ? await scheduler.isEnabled?.()
    : (await request!('cron.status', {})).enabled;
  if (enabled !== true)
    return enabled === false
      ? 'automation-scheduler-disabled'
      : 'automation-observation-unavailable';
  const jobs = scheduler
    ? await scheduler.list({ includeDisabled: true })
    : await listNativeAutomations(request!);
  if (!Array.isArray(jobs) || jobs.some((job) => !job || typeof job.id !== 'string'))
    return 'automation-observation-unavailable';
  const matches = jobs.filter(
    (job) => job.id === record.nativeId || job.declarationKey === record.marker,
  );
  if (!matches.length) return 'intake-automation-update-required';
  const native = matches[0]!;
  if (
    matches.length !== 1 ||
    native.id !== record.nativeId ||
    native.declarationKey !== record.marker ||
    native.agentId !== manifest.agent.id
  )
    return 'automation-ownership-conflict';
  if (native.enabled !== true) return 'intake-automation-update-required';
  if (nativeAutomationHash(native) !== record.nativeHash)
    return 'intake-automation-update-required';
  if (native.state?.lastRunStatus === 'error') return 'automation-execution-failed';
  if (native.state?.lastDeliveryStatus === 'not-delivered' || native.state?.lastDeliveryError)
    return 'automation-delivery-failed';
}
