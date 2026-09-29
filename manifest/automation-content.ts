import { createHash } from 'node:crypto';

import type {
  AutomationRuntime,
  ResolvedAutomation,
  AutomationOverride,
} from './automation-schema.ts';

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
    }
    return item;
  });
}
function hash(json: string): string {
  return createHash('sha256').update(json).digest('hex');
}

/**
 * adapters supply resolved defaults before native comparison; native markers retain unresolved defaults.
 * this helper neither inspects runtime state nor checks support.
 */
export default function automationContent(
  job: ResolvedAutomation,
  runtime: AutomationRuntime,
  defaults: AutomationOverride & { timeoutSeconds?: number } = {},
) {
  const override = job.overrides[runtime];
  const timeoutSeconds =
    job.timeoutSeconds ?? defaults.timeoutSeconds ?? (runtime === 'openclaw' ? 1800 : 'native');
  const schedule = job.schedule;
  const trigger =
    schedule.kind === 'cron'
      ? { kind: schedule.kind, fields: schedule.fields, timezone: schedule.timezone }
      : schedule.kind === 'at'
        ? { kind: schedule.kind, at: schedule.at }
        : { kind: schedule.kind, seconds: schedule.seconds };
  const triggerJson = canonicalJson({ version: 1, trigger });
  const content = {
    version: 1,
    id: job.id,
    runtime,
    enabled: job.enabled,
    applicable: job.runtimes.includes(runtime),
    schedule: job.schedule,
    payload: job.payload,
    timeoutSeconds,
    ...(job.payload.kind === 'prompt'
      ? {
          context: {
            model: override?.model ?? defaults.model ?? 'native',
            effort: override?.effort ?? defaults.effort ?? 'native',
            target: override?.target ?? defaults.target ?? 'independent',
          },
        }
      : {}),
  };
  const json = canonicalJson(content);
  return { content, json, hash: hash(json), triggerJson, triggerHash: hash(triggerJson) };
}
