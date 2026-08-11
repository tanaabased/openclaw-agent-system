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
    'approved-actors': Type.Array(externalGitHubIdentitySchema, {
      minItems: 1,
      uniqueItems: true,
    }),
    'interval-minutes': Type.Optional(Type.Integer({ maximum: 1_440, minimum: 1 })),
    'repository-policy': Type.Optional(
      Type.Object(
        {
          'allowed-owners': Type.Optional(
            Type.Array(externalGitHubIdentitySchema, {
              minItems: 1,
              uniqueItems: true,
            }),
          ),
          'minimum-permission': Type.Optional(Type.Literal('write')),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

type ExternalGitHubNotifications = Static<typeof externalGitHubNotificationsSchema>;

export interface GitHubIdentityPin {
  login: string;
  nodeId: string;
}

export interface GitHubNotificationsConfiguration {
  approvedActors: GitHubIdentityPin[];
  intervalMinutes: number;
  repositoryPolicy: {
    allowedOwners?: GitHubIdentityPin[];
    minimumPermission: 'write';
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
    approvedActors: value['approved-actors'].map(decodeIdentity),
    intervalMinutes: value['interval-minutes'] ?? 5,
    repositoryPolicy: {
      minimumPermission: value['repository-policy']?.['minimum-permission'] ?? 'write',
      ...(value['repository-policy']?.['allowed-owners'] === undefined
        ? {}
        : {
            allowedOwners: value['repository-policy']['allowed-owners'].map(decodeIdentity),
          }),
    },
  };
}
