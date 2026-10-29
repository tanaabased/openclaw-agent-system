import { Type, type Static } from 'typebox';

import decodeProjectPickup, { projectPickupSchema } from './project-pickup-schema.ts';

import {
  assessmentConfigurationSchema,
  decodeAssessmentConfiguration,
} from '../../manifest/assessment-schema.ts';
import type { GitHubIdentityPin, GitHubNotificationPolicy } from './workflow-policy.ts';

const login = Type.String({
  minLength: 1,
  maxLength: 100,
  pattern: '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$',
});
const nodeId = Type.String({ minLength: 1, maxLength: 255, pattern: '^[^\\s\\u0000]+$' });
export const githubIdentityReferenceSchema = Type.Union([
  Type.String({
    maxLength: 256,
    pattern: '^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$',
  }),
  Type.String({
    minLength: 1,
    maxLength: 255,
    pattern: '^(?:[A-Z]+_[A-Za-z0-9_-]+|M[DTE][A-Za-z0-9+/]+={0,2})$',
  }),
  Type.Object({ login, 'node-id': nodeId }, { additionalProperties: false }),
  Type.Object({ name: login, 'node-id': nodeId }, { additionalProperties: false }),
  Type.Object({ owner: login, 'node-id': nodeId }, { additionalProperties: false }),
  Type.Object({ org: login, 'node-id': nodeId }, { additionalProperties: false }),
]);
const identities = () => Type.Array(githubIdentityReferenceSchema);
const customization = Type.Optional(assessmentConfigurationSchema);
const trigger = {
  paused: Type.Optional(Type.Boolean()),
  allowed: Type.Optional(identities()),
};

export const githubV3Properties = {
  'project-pickup': Type.Optional(projectPickupSchema),
  'schema-version': Type.Optional(Type.Literal(3)),
  runtimes: Type.Optional(
    Type.Array(Type.Union([Type.Literal('openclaw'), Type.Literal('codex')]), {
      minItems: 1,
      uniqueItems: true,
    }),
  ),
  'interval-minutes': Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
  'max-concurrent-items': Type.Optional(Type.Integer({ minimum: 1 })),
  'allowed-repository-owners': Type.Array(githubIdentityReferenceSchema, { minItems: 1 }),
  'issue-assignment': Type.Optional(
    Type.Object(
      {
        ...trigger,
        mode: Type.Optional(
          Type.Union([Type.Literal('plan'), Type.Literal('work'), Type.Literal('auto')]),
        ),
        reviewers: Type.Optional(identities()),
        assessment: customization,
        implementation: customization,
        feedback: customization,
      },
      { additionalProperties: false },
    ),
  ),
  'review-request': Type.Optional(
    Type.Object(
      { ...trigger, review: customization, feedback: customization },
      { additionalProperties: false },
    ),
  ),
};

export const externalGitHubV3Schema = Type.Object(githubV3Properties, {
  additionalProperties: false,
});
export type ExternalGitHubV3 = Static<typeof externalGitHubV3Schema>;

function identity(value: Static<typeof githubIdentityReferenceSchema>): GitHubIdentityPin {
  if (typeof value === 'string')
    return value.startsWith('@')
      ? { login: value.slice(1), nodeId: '', reference: value }
      : { login: '', nodeId: value, reference: value };
  const name =
    'login' in value
      ? value.login
      : 'name' in value
        ? value.name
        : 'owner' in value
          ? value.owner
          : value.org;
  return { login: name, nodeId: value['node-id'] };
}

/** normalize execution policy without resolving identities or activating runtime components. */
export default function decodeGitHubV3(value: ExternalGitHubV3): GitHubNotificationPolicy {
  const issue = value['issue-assignment'];
  const review = value['review-request'];
  const reviewers = (issue?.reviewers ?? []).map(identity);
  return {
    schemaVersion: 3,
    runtimes: value.runtimes ?? ['openclaw', 'codex'],
    intervalMinutes: value['interval-minutes'] ?? 5,
    maxConcurrentItems: value['max-concurrent-items'] ?? 3,
    ...(value['project-pickup']
      ? { projectPickup: decodeProjectPickup(value['project-pickup']) }
      : {}),
    allowedRepositoryOwners: value['allowed-repository-owners'].map(identity),
    ...(issue === undefined
      ? {}
      : {
          issueAssignment: {
            paused: issue.paused ?? false,
            allowed: (issue.allowed ?? []).map(identity),
            mode: issue.mode ?? 'auto',
            ...(issue.assessment
              ? { assessment: decodeAssessmentConfiguration(issue.assessment) }
              : {}),
            ...(issue.implementation
              ? { implementation: decodeAssessmentConfiguration(issue.implementation) }
              : {}),
            feedback: {
              inherit: true,
              allowed: reviewers,
              ...decodeAssessmentConfiguration(issue.feedback ?? {}),
            },
            pullRequest: {
              defaultAssignmentActor: true,
              recipients: [
                { source: 'assignment-actor' as const, roles: ['assignee' as const] },
                ...reviewers.map((pin) => ({ ...pin, roles: ['reviewer' as const] })),
              ],
            },
          },
        }),
    ...(review === undefined
      ? {}
      : {
          reviewRequest: {
            paused: review.paused ?? false,
            allowed: (review.allowed ?? []).map(identity),
            ...(review.review ? { review: decodeAssessmentConfiguration(review.review) } : {}),
            feedback: {
              inherit: true,
              allowed: [],
              ...decodeAssessmentConfiguration(review.feedback ?? {}),
            },
          },
        }),
  };
}
