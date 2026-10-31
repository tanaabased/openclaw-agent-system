import { Type, type Static } from 'typebox';

import { assessmentConfigurationSchema } from '../../manifest/assessment-schema.ts';
import normalizeAutomationSchedule, {
  type AutomationSchedule,
} from '../../manifest/automation-schedule.ts';

export const projectPickupSchema = Type.Object(
  {
    paused: Type.Optional(Type.Boolean()),
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
    schedule,
    windowMinutes: value['window-minutes'],
    ...(value.selection ? { selection: value.selection } : {}),
    projects: value.projects,
  };
}
