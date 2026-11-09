import type { AutomationModelSettings } from '../../manifest/automation-schema.ts';
import type { AssessmentConfiguration } from '../../manifest/assessment-schema.ts';
import type { IssuePickupPolicy } from './issue-pickup-schema.ts';
import type { RepositoryRoute } from './repository-scope.ts';

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
  issuePickup?: IssuePickupPolicy;
  schemaVersion: 3;
  runtimes: Array<'openclaw' | 'codex'>;
  intervalMinutes: number;
  maxConcurrentItems: number;
  routing: RepositoryRoute[];
  issueAssignment?: AutomationModelSettings & {
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
