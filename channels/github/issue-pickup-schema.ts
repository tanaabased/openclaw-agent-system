import type { GitHubNotificationPolicy } from './workflow-policy.ts';
import { Type, type Static } from 'typebox';

import { assessmentConfigurationSchema } from '../../manifest/assessment-schema.ts';
import {
  automationModelProperties,
  type AutomationModelSettings,
  automationThreadValueSchema,
  normalizeAutomationThread,
} from '../../manifest/automation-schema.ts';
import type { AutomationSchedule } from '../../manifest/automation-schedule.ts';
import pickupTiming from './issue-pickup-timing.ts';

export const issuePickupSchema = Type.Object(
  {
    ...automationModelProperties,
    paused: Type.Optional(Type.Boolean()),
    thread: Type.Optional(automationThreadValueSchema),
    start: Type.Optional(Type.String()),
    window: Type.Optional(Type.String()),
    duration: Type.Optional(Type.String()),
    end: Type.Optional(Type.String()),
    scans: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
    selection: Type.Optional(
      Type.Object(
        { guidance: assessmentConfigurationSchema.properties.guidance },
        { additionalProperties: false },
      ),
    ),
    projects: Type.Array(
      Type.Object(
        {
          repository: Type.String({
            maxLength: 256,
            pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9_.-]+$',
          }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
          milestone: Type.Object(
            {
              number: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
              policy: Type.Literal('only'),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

type Declaration = Static<typeof issuePickupSchema>;
export interface IssuePickupPolicy extends AutomationModelSettings {
  paused: boolean;
  thread?: { id?: string; name?: string };
  /** undefined is rejected by semantic validation, without throwing from manifest decoding. */
  schedule?: AutomationSchedule;
  windowMinutes: number;
  scanSchedule?: AutomationSchedule;
  timingError?:
    | 'issue-pickup-timing-conflict'
    | 'issue-pickup-schedule-precision'
    | 'issue-pickup-schedule-unsupported';
  selection?: Declaration['selection'];
  projects: Array<Declaration['projects'][number] & { limit: number }>;
}

export default function decodeIssuePickup(value: Declaration): IssuePickupPolicy {
  let timing: ReturnType<typeof pickupTiming> | undefined;
  let timingError: IssuePickupPolicy['timingError'];
  try {
    timing = pickupTiming(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    timingError =
      message === 'issue-pickup-timing-conflict' || message === 'issue-pickup-schedule-precision'
        ? message
        : 'issue-pickup-schedule-unsupported';
  }
  return {
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    paused: value.paused ?? false,
    ...(value.thread === undefined ? {} : { thread: normalizeAutomationThread(value.thread) }),
    schedule: timing?.schedule,
    windowMinutes: timing?.windowMinutes ?? 120,
    ...(timing?.scanSchedule ? { scanSchedule: timing.scanSchedule } : {}),
    ...(timingError ? { timingError } : {}),
    ...(value.selection ? { selection: value.selection } : {}),
    projects: value.projects.map((project) => ({ ...project, limit: project.limit ?? 1 })),
  };
}

export function issuePickupConfigurationCode(policy: GitHubNotificationPolicy) {
  const pickup = policy.issuePickup;
  if (!pickup) return;
  if (pickup.timingError) return pickup.timingError;
  if (!pickup.schedule || pickup.windowMinutes <= 0) return 'issue-pickup-schedule-unsupported';
}
