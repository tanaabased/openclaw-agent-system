import type { GitHubNotificationPolicy } from './workflow-policy.ts';
import { Type, type Static } from 'typebox';
import { instanceIdPattern } from './provider/assignment-claim.ts';

import { assessmentConfigurationSchema } from '../../manifest/assessment-schema.ts';
import normalizeAutomationSchedule, {
  type AutomationSchedule,
} from '../../manifest/automation-schedule.ts';

export const projectPickupSchema = Type.Object(
  {
    paused: Type.Optional(Type.Boolean()),
    coordinator: Type.Optional(
      Type.Object(
        {
          runtime: Type.Union([Type.Literal('codex'), Type.Literal('openclaw')]),
          'instance-id': Type.String({ pattern: instanceIdPattern.source }),
        },
        { additionalProperties: false },
      ),
    ),
    schedule: Type.Unknown(),
    'window-minutes': Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER / 60000 }),
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
      { minItems: 1, maxItems: 1 },
    ),
  },
  { additionalProperties: false },
);

type Declaration = Static<typeof projectPickupSchema>;
export interface ProjectPickupPolicy {
  paused: boolean;
  coordinator?: { runtime: 'codex' | 'openclaw'; instanceId: string };
  /** undefined is rejected by semantic validation, without throwing from manifest decoding. */
  schedule?: AutomationSchedule;
  windowMinutes: number;
  selection?: Declaration['selection'];
  projects: Declaration['projects'];
}

export default function decodeProjectPickup(value: Declaration): ProjectPickupPolicy {
  let schedule: AutomationSchedule | undefined;
  try {
    const parsed = normalizeAutomationSchedule(value.schedule);
    if (parsed.kind === 'cron' || parsed.kind === 'every') schedule = parsed;
  } catch {
    // report an actionable manifest diagnostic through the normal validation owner.
  }
  return {
    paused: value.paused ?? false,
    ...(value.coordinator
      ? {
          coordinator: {
            runtime: value.coordinator.runtime,
            instanceId: value.coordinator['instance-id'],
          },
        }
      : {}),
    schedule,
    windowMinutes: value['window-minutes'],
    ...(value.selection ? { selection: value.selection } : {}),
    projects: value.projects,
  };
}

export function projectPickupConfigurationCode(
  policy: GitHubNotificationPolicy,
  runtime: 'codex' | 'openclaw',
) {
  const pickup = policy.projectPickup;
  if (!pickup) return;
  if (!pickup.coordinator) return 'project-pickup-coordinator-required';
  if (pickup.coordinator.runtime !== runtime) return 'project-pickup-coordinator-mismatch';
  if (!pickup.schedule || pickup.windowMinutes < policy.intervalMinutes)
    return 'project-pickup-schedule-unsupported';
}
