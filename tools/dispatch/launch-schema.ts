import { issueChatTitleGuidance } from '../../agent/tasks/dispatch/issue-chat-title.ts';
import { Type, type Static } from 'typebox';

import { assessmentConfigurationSchema } from '../../manifest/assessment-schema.ts';
import { assessmentSchema, selectedProfileSchema } from '../../agent/model-routing.ts';

export const launchRequestSchema = Type.Object(
  {
    action: Type.Literal('launch'),
    target: Type.String({ minLength: 1, maxLength: 4096 }),
    repository: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    fresh: Type.Optional(
      Type.Boolean({
        description:
          'Legacy accepted field. New operator issue-launch requests already create independent tasks; retries retain the original attempt.',
      }),
    ),
    pullRequest: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 4096,
        description: 'Exact existing same-repository PR URL to continue in either runtime.',
      }),
    ),
    operation: Type.Union([
      Type.Literal('context'),
      Type.Literal('prepare'),
      Type.Literal('reconcile'),
    ]),
    assessment: Type.Optional(assessmentSchema),
    fallback: Type.Optional(Type.Literal('default')),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 80,
        description: issueChatTitleGuidance,
        pattern: '^(?=.*\\S)[^\\u0000-\\u001F\\u007F-\\u009F]+$',
      }),
    ),
    projects: Type.Optional(Type.Array(Type.Unknown(), { maxItems: 1000 })),
    mode: Type.Optional(
      Type.Union([Type.Literal('plan'), Type.Literal('work'), Type.Literal('auto')]),
    ),
    routing: Type.Optional(Type.Partial(selectedProfileSchema)),
    stages: Type.Optional(
      Type.Object(
        {
          assessment: Type.Optional(assessmentConfigurationSchema),
          implementation: Type.Optional(assessmentConfigurationSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export type LaunchRequest = Static<typeof launchRequestSchema>;
