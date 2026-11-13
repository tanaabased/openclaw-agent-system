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

const quantity = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const milestoneId = Type.Union([
  quantity,
  Type.String({
    pattern:
      '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/)?[A-Za-z0-9_.-]+#[1-9][0-9]*(?![\\s\\S])',
  }),
]);

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
            pattern:
              '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/(?:[A-Za-z0-9_.-]+|\\*)(?![\\s\\S])',
          }),
          limit: Type.Optional(
            Type.Union([
              quantity,
              Type.Object(
                {
                  quantity,
                  scope: Type.Optional(
                    Type.Union([Type.Literal('selection'), Type.Literal('repo')]),
                  ),
                },
                { additionalProperties: false },
              ),
            ]),
          ),
          selection: Type.Optional(
            Type.Object(
              { guidance: assessmentConfigurationSchema.properties.guidance },
              { additionalProperties: false },
            ),
          ),
          filters: Type.Optional(
            Type.Object(
              {
                labels: Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: '\\S' }))),
                types: Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: '\\S' }))),
              },
              { additionalProperties: false },
            ),
          ),
          milestone: Type.Optional(
            Type.Object(
              {
                number: Type.Optional(
                  Type.Union([
                    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
                    Type.Array(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }), {
                      minItems: 1,
                      uniqueItems: true,
                    }),
                  ]),
                ),
                ids: Type.Optional(
                  Type.Union([milestoneId, Type.Array(milestoneId, { minItems: 1 })]),
                ),
                policy: Type.Optional(Type.Union([Type.Literal('only'), Type.Literal('prefer')])),
              },
              { additionalProperties: false },
            ),
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
export interface IssuePickupFilters {
  labels?: string[];
  types?: string[];
}
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
  projects: Array<
    Omit<Declaration['projects'][number], 'filters' | 'limit'> & {
      limit: NonNullable<Declaration['projects'][number]['limit']>;
      filters?: IssuePickupFilters;
    }
  >;
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
    projects: value.projects.map(({ filters, ...project }) => ({
      ...project,
      limit: project.limit ?? 1,
      ...(filters
        ? {
            filters: {
              ...(filters.labels ? { labels: filters.labels } : {}),
              ...(filters.types ? { types: filters.types } : {}),
            },
          }
        : {}),
    })),
  };
}

export function issuePickupConfigurationCode(policy: GitHubNotificationPolicy) {
  const pickup = policy.issuePickup;
  if (!pickup) return;
  if (pickup.timingError) return pickup.timingError;
  if (!pickup.schedule || pickup.windowMinutes <= 0) return 'issue-pickup-schedule-unsupported';
}
