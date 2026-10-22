import { Type, type Static } from 'typebox';

import {
  assessmentConfigurationSchema,
  decodeAssessmentConfiguration,
} from '../../manifest/assessment-schema.ts';

const externalGitHubIdentitySchema = Type.Object(
  {
    login: Type.String({
      maxLength: 100,
      minLength: 1,
      pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$',
    }),
    'node-id': Type.String({
      maxLength: 255,
      minLength: 1,
      pattern: '^[^\\u0000\\r\\n\\s]+$',
    }),
  },
  { additionalProperties: false },
);

const externalGitHubApprovedActorSchema = Type.Object(
  {
    ...externalGitHubIdentitySchema.properties,
    'operator-owner': Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const recipientRoles = Type.Array(
  Type.Union([Type.Literal('assignee'), Type.Literal('reviewer')]),
  { minItems: 1, uniqueItems: true },
);
const externalDeliveryRecipientsSchema = Type.Object(
  {
    recipients: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Object(
            { ...externalGitHubIdentitySchema.properties, roles: recipientRoles },
            { additionalProperties: false },
          ),
          Type.Object(
            { source: Type.Literal('assignment-actor'), roles: recipientRoles },
            { additionalProperties: false },
          ),
        ]),
      ),
    ),
  },
  { additionalProperties: false },
);

const externalNotificationTriggerSchema = Type.Object(
  {
    allowed: Type.Optional(Type.Array(externalGitHubApprovedActorSchema, { uniqueItems: true })),
    enabled: Type.Optional(Type.Boolean()),
    paused: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const externalFeedbackSchema = Type.Union([
  Type.Boolean(),
  Type.Object(
    {
      inherit: Type.Optional(Type.Boolean()),
      allowed: Type.Optional(Type.Array(externalGitHubIdentitySchema)),
      ...assessmentConfigurationSchema.properties,
    },
    { additionalProperties: false },
  ),
]);

const externalGitHubNotificationPolicySchema = Type.Object(
  {
    'schema-version': Type.Optional(Type.Literal(2)),
    runtimes: Type.Optional(
      Type.Array(Type.Union([Type.Literal('openclaw'), Type.Literal('codex')]), {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
    'interval-minutes': Type.Optional(Type.Integer({ minimum: 1, maximum: 1_440 })),
    'max-concurrent-items': Type.Optional(Type.Integer({ minimum: 1 })),
    cleanup: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          'grace-minutes': Type.Optional(Type.Integer({ minimum: 0, maximum: 43_200 })),
        },
        { additionalProperties: false },
      ),
    ),
    'allowed-repository-owners': Type.Array(externalGitHubIdentitySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    'issue-assignment': Type.Optional(
      Type.Object(
        {
          ...externalNotificationTriggerSchema.properties,
          assessment: Type.Optional(assessmentConfigurationSchema),
          implementation: Type.Optional(assessmentConfigurationSchema),
          'pull-request': Type.Optional(externalDeliveryRecipientsSchema),
          feedback: Type.Optional(externalFeedbackSchema),
          mode: Type.Optional(
            Type.Union([Type.Literal('plan'), Type.Literal('work'), Type.Literal('auto')]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    'review-request': Type.Optional(
      Type.Object(
        {
          ...externalNotificationTriggerSchema.properties,
          review: Type.Optional(assessmentConfigurationSchema),
          feedback: Type.Optional(externalFeedbackSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const externalGitHubNotificationsSchema = externalGitHubNotificationPolicySchema;

export type ExternalGitHubNotifications = Static<typeof externalGitHubNotificationsSchema>;

export type {
  GitHubIdentityPin,
  GitHubRecipientRole,
  GitHubPullRequestRecipient,
  GitHubApprovedActor,
  GitHubFeedbackPolicy,
  GitHubNotificationPolicy,
  GitHubNotificationsDeclaration,
} from './workflow-policy.ts';

import type { GitHubIdentityPin, GitHubNotificationsDeclaration } from './workflow-policy.ts';

/** Decode the channel-owned github.notifications manifest fragment. */
export function decodeGitHubNotifications(
  value: ExternalGitHubNotifications,
): GitHubNotificationsDeclaration {
  const decodeIdentity = (
    identity: Static<typeof externalGitHubIdentitySchema>,
  ): GitHubIdentityPin => ({
    login: identity.login,
    nodeId: identity['node-id'],
  });

  const feedback = (input: Static<typeof externalFeedbackSchema> | undefined) =>
    input === undefined
      ? {}
      : {
          feedback:
            typeof input === 'boolean'
              ? input
              : {
                  inherit: input.inherit ?? false,
                  allowed: (input.allowed ?? []).map(decodeIdentity),
                  ...decodeAssessmentConfiguration(input),
                },
        };
  const actors = (trigger: Static<typeof externalNotificationTriggerSchema>) =>
    (trigger.allowed ?? []).map((actor) => ({
      ...decodeIdentity(actor),
      operatorOwner: actor['operator-owner'] ?? false,
    }));
  return {
    schemaVersion: 2,
    runtimes: value.runtimes ?? ['openclaw', 'codex'],
    intervalMinutes: value['interval-minutes'] ?? 5,
    maxConcurrentItems: value['max-concurrent-items'] ?? 3,
    allowedRepositoryOwners: value['allowed-repository-owners'].map(decodeIdentity),
    ...(value['issue-assignment'] === undefined
      ? {}
      : {
          issueAssignment: {
            ...(value['issue-assignment'].paused === undefined &&
            value['issue-assignment'].enabled === undefined
              ? {}
              : { paused: value['issue-assignment'].paused ?? !value['issue-assignment'].enabled }),
            allowed: actors(value['issue-assignment']),
            mode: value['issue-assignment'].mode ?? 'auto',
            ...feedback(value['issue-assignment'].feedback),
            ...(value['issue-assignment']['pull-request'] === undefined
              ? {}
              : {
                  pullRequest: {
                    ...(value['issue-assignment']['pull-request'].recipients === undefined
                      ? {}
                      : {
                          recipients: value['issue-assignment']['pull-request'].recipients.map(
                            (entry) => ({
                              ...('source' in entry
                                ? { source: entry.source }
                                : decodeIdentity(entry)),
                              roles: entry.roles,
                            }),
                          ),
                        }),
                  },
                }),
            ...(value['issue-assignment'].implementation === undefined
              ? {}
              : {
                  implementation: decodeAssessmentConfiguration(
                    value['issue-assignment'].implementation,
                  ),
                }),
            ...(value['issue-assignment'].assessment === undefined
              ? {}
              : {
                  assessment: decodeAssessmentConfiguration(value['issue-assignment'].assessment),
                }),
          },
        }),
    ...(value['review-request'] === undefined
      ? {}
      : {
          reviewRequest: {
            allowed: actors(value['review-request']),
            ...feedback(value['review-request'].feedback),
            ...(value['review-request'].review === undefined
              ? {}
              : { review: decodeAssessmentConfiguration(value['review-request'].review) }),
            ...(value['review-request'].paused === undefined &&
            value['review-request'].enabled === undefined
              ? {}
              : { paused: value['review-request'].paused ?? !value['review-request'].enabled }),
          },
        }),
  };
}
