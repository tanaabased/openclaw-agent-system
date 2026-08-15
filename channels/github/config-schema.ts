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

export const externalGitHubNotificationsSchema = Type.Object(
  {
    'assignment-types': Type.Optional(
      Type.Array(Type.Union([Type.Literal('issue'), Type.Literal('pull-request')]), {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
    'approved-actors': Type.Array(externalGitHubIdentitySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    'allowed-repository-owners': Type.Optional(
      Type.Array(externalGitHubIdentitySchema, {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
    'interval-minutes': Type.Optional(Type.Integer({ maximum: 1_440, minimum: 1 })),
  },
  { additionalProperties: false },
);

type ExternalGitHubNotifications = Static<typeof externalGitHubNotificationsSchema>;

export interface GitHubIdentityPin {
  login: string;
  nodeId: string;
}

export interface GitHubNotificationsConfiguration {
  assignmentTypes: Array<'issue' | 'pull-request'>;
  approvedActors: GitHubIdentityPin[];
  allowedRepositoryOwners?: GitHubIdentityPin[];
  intervalMinutes: number;
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
    approvedActors: value['approved-actors'].map(decodeIdentity),
    ...(value['allowed-repository-owners'] === undefined
      ? {}
      : {
          allowedRepositoryOwners: value['allowed-repository-owners'].map(decodeIdentity),
        }),
    intervalMinutes: value['interval-minutes'] ?? 5,
  };
}
