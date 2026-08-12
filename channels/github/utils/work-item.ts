export interface GitHubIdentity {
  login: string;
  nodeId: string;
  type: string;
}

export interface GitHubAssignedItemCandidate {
  databaseId: number;
  itemType: 'issue' | 'pull-request';
  nodeId: string;
  number: number;
  repositoryPath: string;
  updatedAt: string;
}

export interface GitHubRepositoryIdentity {
  archived: boolean;
  cloneUrl: string;
  databaseId: number;
  defaultBranch: string;
  disabled: boolean;
  name: string;
  nodeId: string;
  owner: GitHubIdentity;
}

export interface GitHubCanonicalWorkItem {
  assignees: GitHubIdentity[];
  databaseId: number;
  itemType: 'issue' | 'pull-request';
  nodeId: string;
  number: number;
  state: 'closed' | 'open';
  updatedAt: string;
}

export interface GitHubAssignmentEvent {
  actor: GitHubIdentity;
  assignee: GitHubIdentity;
  createdAt: string;
  databaseId: number;
  event: 'assigned' | 'unassigned';
  nodeId: string;
}

export type GitHubRepositoryPermission =
  'admin' | 'maintain' | 'none' | 'read' | 'triage' | 'write';

export function githubWorkItemKey(repositoryNodeId: string, itemNumber: number): string {
  if (!repositoryNodeId.trim()) throw new Error('GitHub repository node ids must not be empty.');
  if (!Number.isSafeInteger(itemNumber) || itemNumber < 1) {
    throw new Error('GitHub work item numbers must be positive safe integers.');
  }
  return `github:${repositoryNodeId.trim()}:${itemNumber}`;
}

export function githubRepositoryPath(value: string): { name: string; owner: string } {
  const match = /^(?:https:\/\/api\.github\.com)?\/repos\/([^/]+)\/([^/?#]+)$/u.exec(value);
  if (!match?.[1] || !match[2]) throw new Error('GitHub returned an unsupported repository path.');
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const segment = /^[A-Za-z0-9_.-]+$/u;
  if (!segment.test(owner) || !segment.test(name)) {
    throw new Error('GitHub returned an invalid repository path.');
  }
  return { name, owner };
}
