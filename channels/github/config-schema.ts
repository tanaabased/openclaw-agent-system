import { Type, type Static } from 'typebox';

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

const externalPullRequestRecipientsSchema = Type.Object(
  {
    assignees: Type.Optional(
      Type.Union([
        Type.Literal('assignment-actor'),
        Type.Array(externalGitHubIdentitySchema, { maxItems: 10 }),
      ]),
    ),
    reviewers: Type.Optional(Type.Array(externalGitHubIdentitySchema)),
  },
  { additionalProperties: false },
);

const externalLegacyGitHubNotificationsSchema = Type.Object(
  {
    'assignment-types': Type.Optional(
      Type.Array(Type.Union([Type.Literal('issue'), Type.Literal('pull-request')]), {
        uniqueItems: true,
      }),
    ),
    'approved-actors': Type.Optional(
      Type.Array(externalGitHubApprovedActorSchema, {
        uniqueItems: true,
      }),
    ),
    'approved-issue-assigners': Type.Optional(
      Type.Array(externalGitHubIdentitySchema, { uniqueItems: true }),
    ),
    'approved-feedback-authors': Type.Optional(
      Type.Array(externalGitHubIdentitySchema, { uniqueItems: true }),
    ),
    'allowed-repository-owners': Type.Optional(
      Type.Array(externalGitHubIdentitySchema, {
        uniqueItems: true,
      }),
    ),
    'initial-mode': Type.Optional(Type.Union([Type.Literal('guided'), Type.Literal('work')])),
    'interval-minutes': Type.Optional(Type.Integer({ maximum: 1_440, minimum: 1 })),
    'max-concurrent-issues': Type.Optional(Type.Integer({ minimum: 1 })),
    'pull-request': Type.Optional(externalPullRequestRecipientsSchema),
  },
  { additionalProperties: false },
);

const externalNotificationTriggerSchema = Type.Object(
  {
    allowed: Type.Optional(Type.Array(externalGitHubApprovedActorSchema, { uniqueItems: true })),
  },
  { additionalProperties: false },
);

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
          mode: Type.Optional(
            Type.Union([Type.Literal('plan'), Type.Literal('work'), Type.Literal('auto')]),
          ),
        },
        { additionalProperties: false },
      ),
    ),
    'review-request': Type.Optional(externalNotificationTriggerSchema),
    feedback: Type.Optional(externalNotificationTriggerSchema),
  },
  { additionalProperties: false },
);

export const externalGitHubNotificationsSchema = Type.Union([
  externalLegacyGitHubNotificationsSchema,
  externalGitHubNotificationPolicySchema,
]);

type ExternalGitHubNotifications = Static<typeof externalGitHubNotificationsSchema>;

export interface GitHubIdentityPin {
  login: string;
  nodeId: string;
}

export interface GitHubApprovedActor extends GitHubIdentityPin {
  operatorOwner?: boolean;
}

export interface GitHubNotificationsConfiguration {
  schemaVersion?: never;
  assignmentTypes: Array<'issue' | 'pull-request'>;
  approvedActors?: GitHubApprovedActor[];
  approvedIssueAssigners?: GitHubIdentityPin[];
  approvedFeedbackAuthors?: GitHubIdentityPin[];
  allowedRepositoryOwners?: GitHubIdentityPin[];
  initialMode?: 'guided' | 'work';
  intervalMinutes: number;
  maxConcurrentIssues: number;
  pullRequest?: {
    assignees: 'assignment-actor' | GitHubIdentityPin[];
    reviewers: GitHubIdentityPin[];
  };
}

export interface GitHubNotificationPolicy {
  schemaVersion: 2;
  runtimes: Array<'openclaw' | 'codex'>;
  intervalMinutes: number;
  maxConcurrentItems: number;
  allowedRepositoryOwners: GitHubIdentityPin[];
  issueAssignment?: { allowed: GitHubApprovedActor[]; mode: 'plan' | 'work' | 'auto' };
  reviewRequest?: { allowed: GitHubApprovedActor[] };
  feedback?: { allowed: GitHubApprovedActor[] };
}

export type GitHubNotificationsDeclaration =
  GitHubNotificationsConfiguration | GitHubNotificationPolicy;

/** keep version 2 declarations out of legacy channel execution and authority. */
export function legacyGitHubNotifications(
  declaration: GitHubNotificationsDeclaration | undefined,
): GitHubNotificationsConfiguration | undefined {
  return declaration?.schemaVersion === 2 ? undefined : declaration;
}

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

  if ('schema-version' in value) {
    const actors = (trigger: Static<typeof externalNotificationTriggerSchema>) =>
      (trigger.allowed ?? []).map((actor) => ({
        ...decodeIdentity(actor),
        operatorOwner: actor['operator-owner'] ?? false,
      }));
    return {
      schemaVersion: 2,
      runtimes: value.runtimes ?? ['openclaw', 'codex'],
      intervalMinutes: value['interval-minutes'] ?? 5,
      maxConcurrentItems: value['max-concurrent-items'] ?? 2,
      allowedRepositoryOwners: value['allowed-repository-owners'].map(decodeIdentity),
      ...(value['issue-assignment'] === undefined
        ? {}
        : {
            issueAssignment: {
              allowed: actors(value['issue-assignment']),
              mode: value['issue-assignment'].mode ?? 'plan',
            },
          }),
      ...(value['review-request'] === undefined
        ? {}
        : { reviewRequest: { allowed: actors(value['review-request']) } }),
      ...(value.feedback === undefined ? {} : { feedback: { allowed: actors(value.feedback) } }),
    };
  }

  return {
    assignmentTypes: value['assignment-types'] ?? ['issue', 'pull-request'],
    ...(value['approved-actors'] === undefined
      ? {}
      : {
          approvedActors: value['approved-actors'].map((actor) => ({
            ...decodeIdentity(actor),
            ...(actor['operator-owner'] === undefined
              ? {}
              : { operatorOwner: actor['operator-owner'] }),
          })),
        }),
    ...(value['approved-issue-assigners'] === undefined
      ? {}
      : { approvedIssueAssigners: value['approved-issue-assigners'].map(decodeIdentity) }),
    ...(value['approved-feedback-authors'] === undefined
      ? {}
      : { approvedFeedbackAuthors: value['approved-feedback-authors'].map(decodeIdentity) }),
    ...(value['allowed-repository-owners'] === undefined
      ? {}
      : {
          allowedRepositoryOwners: value['allowed-repository-owners'].map(decodeIdentity),
        }),
    initialMode: value['initial-mode'] ?? 'work',
    intervalMinutes: value['interval-minutes'] ?? 5,
    maxConcurrentIssues: value['max-concurrent-issues'] ?? 2,
    pullRequest: {
      assignees:
        value['pull-request']?.assignees === undefined ||
        value['pull-request'].assignees === 'assignment-actor'
          ? 'assignment-actor'
          : value['pull-request'].assignees.map(decodeIdentity),
      reviewers: value['pull-request']?.reviewers?.map(decodeIdentity) ?? [],
    },
  };
}
