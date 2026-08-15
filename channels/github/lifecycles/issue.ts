import type {
  GitHubNotificationLifecycle,
  GitHubNotificationLifecycleBoundaryInput,
  GitHubNotificationLifecycleWorktree,
} from './types.ts';

export interface GitHubIssueLifecycleWorktreeService {
  inspectGitHub(input: {
    agentId: string;
    cloneUrl: string;
    defaultBranch: string;
    itemDatabaseId: number;
    itemType: 'issue';
    repositoryDatabaseId: number;
    signal?: AbortSignal;
  }): Promise<GitHubNotificationLifecycleWorktree | undefined>;
  prepareGitHub(input: {
    agentId: string;
    cloneUrl: string;
    defaultBranch: string;
    itemDatabaseId: number;
    itemType: 'issue';
    repositoryDatabaseId: number;
    signal?: AbortSignal;
  }): Promise<GitHubNotificationLifecycleWorktree>;
}

function worktreeInput(input: GitHubNotificationLifecycleBoundaryInput) {
  if (input.item.itemType !== 'issue') {
    throw new Error('The issue lifecycle received another GitHub item type.');
  }
  return {
    agentId: input.agentId,
    cloneUrl: input.item.repositoryCloneUrl,
    defaultBranch: input.item.repositoryDefaultBranch,
    itemDatabaseId: input.item.itemDatabaseId,
    itemType: input.item.itemType,
    repositoryDatabaseId: input.item.repositoryDatabaseId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

/** Own issue-assignment intake and its required managed worktree. */
export default class GitHubIssueLifecycle implements GitHubNotificationLifecycle {
  readonly id = 'issue' as const;
  readonly worktree;

  constructor(worktrees: GitHubIssueLifecycleWorktreeService) {
    this.worktree = {
      inspect: (input: GitHubNotificationLifecycleBoundaryInput) =>
        worktrees.inspectGitHub(worktreeInput(input)),
      prepare: (input: GitHubNotificationLifecycleBoundaryInput) =>
        worktrees.prepareGitHub(worktreeInput(input)),
      required: true as const,
    };
  }
}
