import type { AssessmentConfiguration } from '../../manifest/assessment-schema.ts';

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

export interface GitHubApprovedActor extends GitHubIdentityPin {
  operatorOwner?: boolean;
}

export type GitHubFeedbackPolicy =
  boolean | ({ inherit: boolean; allowed: GitHubIdentityPin[] } & AssessmentConfiguration);

/** effective workflow controls shared by the configuration decoders and native runtimes. */
export interface GitHubNotificationPolicy {
  schemaVersion: 2 | 3;
  runtimes: Array<'openclaw' | 'codex'>;
  intervalMinutes: number;
  maxConcurrentItems: number;
  allowedRepositoryOwners: GitHubIdentityPin[];
  issueAssignment?: {
    paused?: boolean;
    enabled?: boolean;
    allowed: GitHubApprovedActor[];
    mode: 'plan' | 'work' | 'auto';
    assessment?: AssessmentConfiguration;
    implementation?: AssessmentConfiguration;
    pullRequest?: { recipients?: GitHubPullRequestRecipient[] };
    feedback?: GitHubFeedbackPolicy;
  };
  reviewRequest?: {
    paused?: boolean;
    allowed: GitHubApprovedActor[];
    enabled?: boolean;
    review?: AssessmentConfiguration;
    feedback?: GitHubFeedbackPolicy;
  };
}

export type GitHubNotificationsDeclaration = GitHubNotificationPolicy;

/** Map normalized controls back to the selected public declaration for source diagnostics. */
export function githubWorkflowPath(policy: GitHubNotificationPolicy | undefined, suffix: string) {
  return `${policy?.schemaVersion === 3 ? '/github' : '/github/notifications'}/${suffix}`;
}
