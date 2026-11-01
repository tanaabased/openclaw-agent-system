import type { AssessmentConfiguration } from '../../manifest/assessment-schema.ts';
import type { ProjectPickupPolicy } from './project-pickup-schema.ts';

/** input provenance is retained without selecting a separate execution engine. */
export interface GitHubIdentityPin {
  login: string;
  nodeId: string;
  /** compact input must be resolved by an authorized consumer before matching or publication. */
  reference?: string;
}

export type GitHubRecipientRole = 'assignee' | 'reviewer';
export type GitHubPullRequestRecipient = (GitHubIdentityPin | { source: 'assignment-actor' }) & {
  roles: GitHubRecipientRole[];
};

export type GitHubApprovedActor = GitHubIdentityPin;

export type GitHubFeedbackPolicy = {
  inherit: boolean;
  allowed: GitHubIdentityPin[];
} & AssessmentConfiguration;

/** effective workflow controls shared by the configuration decoder and native runtimes. */
export interface GitHubNotificationPolicy {
  projectPickup?: ProjectPickupPolicy;
  schemaVersion: 3;
  runtimes: Array<'openclaw' | 'codex'>;
  intervalMinutes: number;
  maxConcurrentItems: number;
  allowedRepositoryOwners: GitHubIdentityPin[];
  routing?: string[];
  issueAssignment?: {
    paused?: boolean;
    allowed: GitHubApprovedActor[];
    mode: 'plan' | 'work' | 'auto';
    assessment?: AssessmentConfiguration;
    implementation?: AssessmentConfiguration;
    pullRequest?: { recipients?: GitHubPullRequestRecipient[]; defaultAssignmentActor?: boolean };
    feedback?: GitHubFeedbackPolicy;
  };
  reviewRequest?: {
    paused?: boolean;
    allowed: GitHubApprovedActor[];
    review?: AssessmentConfiguration;
    feedback?: GitHubFeedbackPolicy;
  };
}

export type GitHubNotificationsDeclaration = GitHubNotificationPolicy;
