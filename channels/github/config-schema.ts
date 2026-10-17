import { Type, type Static } from 'typebox';

import {
  assessmentConfigurationSchema,
  decodeAssessmentConfiguration,
  type AssessmentConfiguration,
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
    'schema-version': Type.Literal(2),
    runtimes: Type.Optional(
      Type.Array(Type.Union([Type.Literal('openclaw'), Type.Literal('codex')]), {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
    'interval-minutes': Type.Optional(Type.Integer({ minimum: 1, maximum: 1_440 })),
    'max-concurrent-items': Type.Optional(Type.Integer({ minimum: 1 })),
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

type ExternalGitHubNotifications = Static<typeof externalGitHubNotificationsSchema>;

export interface GitHubIdentityPin {
  login: string;
  nodeId: string;
}

export type GitHubRecipientRole = 'assignee' | 'reviewer';
export type GitHubPullRequestRecipient = (GitHubIdentityPin | { source: 'assignment-actor' }) & {
  roles: GitHubRecipientRole[];
};

export interface GitHubApprovedActor extends GitHubIdentityPin {
  operatorOwner?: boolean;
}

export type GitHubFeedbackPolicy =
  boolean | ({ inherit: boolean; allowed: GitHubIdentityPin[] } & AssessmentConfiguration);

export interface GitHubNotificationPolicy {
  schemaVersion: 2;
  runtimes: Array<'openclaw' | 'codex'>;
  intervalMinutes: number;
  maxConcurrentItems: number;
  allowedRepositoryOwners: GitHubIdentityPin[];
  issueAssignment?: {
    enabled?: boolean;
    allowed: GitHubApprovedActor[];
    mode: 'plan' | 'work' | 'auto';
    assessment?: AssessmentConfiguration;
    implementation?: AssessmentConfiguration;
    pullRequest?: { recipients?: GitHubPullRequestRecipient[] };
    feedback?: GitHubFeedbackPolicy;
  };
  reviewRequest?: {
    allowed: GitHubApprovedActor[];
    enabled?: boolean;
    review?: AssessmentConfiguration;
    feedback?: GitHubFeedbackPolicy;
  };
}

export type GitHubNotificationsDeclaration = GitHubNotificationPolicy;

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
            ...(value['issue-assignment'].enabled === undefined
              ? {}
              : { enabled: value['issue-assignment'].enabled }),
            allowed: actors(value['issue-assignment']),
            mode: value['issue-assignment'].mode ?? 'plan',
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
            ...(value['review-request'].enabled === undefined
              ? {}
              : { enabled: value['review-request'].enabled }),
          },
        }),
  };
}
