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

export interface GitHubNotificationItemSelector {
  itemType: 'issue' | 'pull-request';
  number: number;
  repository: string;
}

/** Match one notification item against an exact repository, kind, and number selector. */
export function githubNotificationItemMatchesSelector(
  item: Pick<GitHubNotificationItemSelector, 'itemType' | 'number'>,
  repository: string,
  selector: GitHubNotificationItemSelector,
): boolean {
  return (
    item.itemType === selector.itemType &&
    item.number === selector.number &&
    repository.toLowerCase() === selector.repository.toLowerCase()
  );
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

export interface GitHubMilestone {
  nodeId: string;
  number: number;
  state: 'open' | 'closed';
}

export interface GitHubPullRequestIdentity {
  author?: GitHubIdentity;
  baseRef: string;
  baseRepositoryDatabaseId: number;
  baseRepositoryNodeId: string;
  draft: boolean;
  headRef: string;
  headRepositoryDatabaseId?: number;
  headRepositoryNodeId?: string;
  headSha: string;
  merged: boolean;
}

interface GitHubCanonicalWorkItemBase {
  assignees: GitHubIdentity[];
  databaseId: number;
  nodeId: string;
  number: number;
  state: 'closed' | 'open';
  updatedAt: string;
}

export type GitHubCanonicalWorkItem = GitHubCanonicalWorkItemBase &
  (
    | { itemType: 'issue'; pullRequest?: never; title?: string; milestone?: GitHubMilestone | null }
    | { itemType: 'pull-request'; pullRequest: GitHubPullRequestIdentity }
  );

export interface GitHubAssignmentEvent {
  actor: GitHubIdentity;
  assignee: GitHubIdentity;
  createdAt: string;
  databaseId: number;
  event: 'assigned' | 'unassigned';
  nodeId: string;
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

/** pinned identity comparisons require both the immutable id and case-insensitive login. */
export function githubIdentityMatches(
  left: Pick<GitHubIdentity, 'login' | 'nodeId'>,
  right: Pick<GitHubIdentity, 'login' | 'nodeId'>,
): boolean {
  return (
    Boolean(left.nodeId && right.nodeId && left.login && right.login) &&
    left.nodeId === right.nodeId &&
    left.login.toLowerCase() === right.login.toLowerCase()
  );
}

/** merge matching pins while rejecting conflicting immutable identities. */
export function githubIdentitySet<T extends Pick<GitHubIdentity, 'login' | 'nodeId'>>(
  identities: readonly T[],
  merge: (left: T, right: T) => T = (left) => left,
): T[] {
  const nodes = new Map<string, T>();
  const logins = new Map<string, string>();
  for (const identity of identities) {
    if (!identity.login || !identity.nodeId) throw new Error('github-identity-unresolved');
    const normalized = identity.login.toLowerCase();
    const previous = nodes.get(identity.nodeId);
    if (
      (previous && !githubIdentityMatches(previous, identity)) ||
      (logins.has(normalized) && logins.get(normalized) !== identity.nodeId)
    )
      throw new Error('github-identity-conflict');
    nodes.set(identity.nodeId, previous ? merge(previous, identity) : identity);
    logins.set(normalized, identity.nodeId);
  }
  return [...nodes.values()];
}
