import type { GitHubCanonicalIssueComment } from '../conversation/comment-admission.ts';
import type {
  GitHubAssignedItemCandidate,
  GitHubAssignmentEvent,
  GitHubCanonicalWorkItem,
  GitHubIdentity,
  GitHubRepositoryIdentity,
  GitHubRepositoryPermission,
} from './work-item.ts';

export interface GitHubNotificationItemContextComment {
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
  body: string;
  comments: GitHubNotificationItemContextComment[];
  files?: GitHubNotificationItemContextFile[];
  labels: string[];
  title: string;
  truncated: boolean;
}

export interface GitHubAssignedItemDiscovery {
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
  readonly identity: GitHubIdentity;
  discoverAssigned(
    updatedSince: string,
    assignmentTypes: readonly ('issue' | 'pull-request')[],
  ): Promise<GitHubAssignedItemDiscovery>;
  getItem(owner: string, name: string, number: number): Promise<GitHubCanonicalWorkItem>;
  getPermission(owner: string, name: string, login: string): Promise<GitHubRepositoryPermission>;
  getRepository(owner: string, name: string): Promise<GitHubRepositoryIdentity>;
  listAssignmentEvents(
    owner: string,
    name: string,
    number: number,
  ): Promise<{ events: GitHubAssignmentEvent[]; truncated: boolean }>;
}

export interface GitHubNotificationCommentClient {
  readonly identity: GitHubIdentity;
  getIssueComment(
    owner: string,
    name: string,
    number: number,
    commentDatabaseId: number,
  ): Promise<GitHubCanonicalIssueComment>;
  listIssueComments(owner: string, name: string, number: number): Promise<GitHubIssueCommentPage>;
}

export interface GitHubNotificationPublicationClient {
  readonly identity: GitHubIdentity;
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
    GitHubNotificationCommentClient,
    GitHubNotificationPublicationClient {}
