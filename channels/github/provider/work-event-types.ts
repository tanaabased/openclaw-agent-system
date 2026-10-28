import type { GitHubPullRequestReviewClient } from './review-types.ts';
import type { GitHubCanonicalIssueComment } from './comment-admission.ts';
import type { RoutingMetadata } from './routing-metadata.ts';
import type {
  GitHubAssignedItemCandidate,
  GitHubAssignmentEvent,
  GitHubCanonicalWorkItem,
  GitHubIdentity,
  GitHubMilestone,
  GitHubRepositoryIdentity,
} from './work-item.ts';

export interface GitHubNotificationItemContextComment {
  url?: string;
  authorLogin: string;
  body: string;
  createdAt: string;
}

export interface GitHubNotificationItemContextFile {
  additions: number;
  changes: number;
  deletions: number;
  filename: string;
  previousFilename?: string;
  status: string;
}

export interface GitHubNotificationItemContext {
  nativeRoutingMetadata?: RoutingMetadata;
  routingMetadata?: RoutingMetadata;
  body: string;
  comments: GitHubNotificationItemContextComment[];
  files?: GitHubNotificationItemContextFile[];
  labels: string[];
  title: string;
  truncated: boolean;
}

export interface GitHubAssignedItemDiscovery {
  nextPage?: number;
  candidates: GitHubAssignedItemCandidate[];
  incomplete: boolean;
  totalCount: number;
  truncated: boolean;
}

export interface GitHubIssueCommentReceipt {
  databaseId: number;
  nodeId: string;
}

export interface GitHubIssueCommentReconciliationReceipt extends GitHubIssueCommentReceipt {
  body: string;
}

export interface GitHubIssueCommentPage {
  comments: GitHubCanonicalIssueComment[];
  truncated: boolean;
}

export interface GitHubNotificationIntakeClient {
  resolveIdentity?(reference: string): Promise<GitHubIdentity>;
  resolveIdentities?(references: readonly string[]): Promise<GitHubIdentity[]>;
  readonly identity: GitHubIdentity;
  discoverAssigned(
    updatedSince: string,
    assignmentTypes: readonly ('issue' | 'pull-request')[],
    page?: number,
  ): Promise<GitHubAssignedItemDiscovery>;
  getItem(owner: string, name: string, number: number): Promise<GitHubCanonicalWorkItem>;
  getRepository(owner: string, name: string): Promise<GitHubRepositoryIdentity>;
  getMilestone?(owner: string, name: string, number: number): Promise<GitHubMilestone>;
  listAssignmentEvents(
    owner: string,
    name: string,
    number: number,
  ): Promise<{ events: GitHubAssignmentEvent[]; truncated: boolean }>;
}

export interface GitHubNotificationItemContextClient {
  getItemContext(
    owner: string,
    name: string,
    number: number,
    itemType?: 'issue' | 'pull-request',
    includeRoutingMetadata?: boolean,
  ): Promise<GitHubNotificationItemContext>;
}

export interface GitHubNotificationCommentClient {
  readonly reviews?: GitHubPullRequestReviewClient;
  readonly identity: GitHubIdentity;
  readonly maximumCommentCharacters?: number;
  getIssueComment(
    owner: string,
    name: string,
    number: number,
    commentDatabaseId: number,
  ): Promise<GitHubCanonicalIssueComment>;
  listIssueCommentPage?(
    owner: string,
    name: string,
    number: number,
    page: number,
    since: string,
  ): Promise<GitHubIssueCommentPage>;
  listIssueComments(owner: string, name: string, number: number): Promise<GitHubIssueCommentPage>;
}

export interface GitHubNotificationPublicationClient {
  readonly reviews?: GitHubPullRequestReviewClient;
  readonly identity: GitHubIdentity;
  readonly maximumCommentCharacters?: number;
  createIssueComment(
    owner: string,
    name: string,
    number: number,
    body: string,
  ): Promise<GitHubIssueCommentReceipt>;
  findOwnIssueComment(
    owner: string,
    name: string,
    number: number,
    marker: string,
  ): Promise<GitHubIssueCommentReconciliationReceipt | undefined>;
  getIssueComment(
    owner: string,
    name: string,
    number: number,
    commentDatabaseId: number,
  ): Promise<GitHubCanonicalIssueComment>;
}

export interface GitHubNotificationProviderClient
  extends
    GitHubNotificationIntakeClient,
    GitHubNotificationItemContextClient,
    GitHubNotificationCommentClient,
    GitHubNotificationPublicationClient {}
