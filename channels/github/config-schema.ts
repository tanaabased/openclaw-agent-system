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

export const externalGitHubNotificationsSchema = Type.Object(
  {
    'assignment-types': Type.Optional(
      Type.Array(Type.Union([Type.Literal('issue'), Type.Literal('pull-request')]), {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
    'approved-actors': Type.Array(externalGitHubApprovedActorSchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    'allowed-repository-owners': Type.Optional(
      Type.Array(externalGitHubIdentitySchema, {
        minItems: 1,
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

type ExternalGitHubNotifications = Static<typeof externalGitHubNotificationsSchema>;

export interface GitHubIdentityPin {
  login: string;
  nodeId: string;
}

export interface GitHubApprovedActor extends GitHubIdentityPin {
  operatorOwner?: boolean;
}

export interface GitHubNotificationsConfiguration {
  assignmentTypes: Array<'issue' | 'pull-request'>;
  approvedActors: GitHubApprovedActor[];
  allowedRepositoryOwners?: GitHubIdentityPin[];
  initialMode?: 'guided' | 'work';
  intervalMinutes: number;
  maxConcurrentIssues: number;
  pullRequest?: {
    assignees: 'assignment-actor' | GitHubIdentityPin[];
    reviewers: GitHubIdentityPin[];
  };
}

/** Decode the channel-owned github.notifications manifest fragment. */
export function decodeGitHubNotifications(
  value: ExternalGitHubNotifications,
): GitHubNotificationsConfiguration {
  const decodeIdentity = (
    identity: Static<typeof externalGitHubIdentitySchema>,
  ): GitHubIdentityPin => ({
    login: identity.login,
    nodeId: identity['node-id'],
  });

  return {
    assignmentTypes: value['assignment-types'] ?? ['issue', 'pull-request'],
    approvedActors: value['approved-actors'].map((actor) => ({
      ...decodeIdentity(actor),
      ...(actor['operator-owner'] === undefined ? {} : { operatorOwner: actor['operator-owner'] }),
    })),
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
