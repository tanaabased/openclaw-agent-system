import githubNotificationIssueLifecycleInstructions from '../conversation/prompts/lifecycle-issue.ts';
import githubNotificationItemContext from './context.ts';
import type {
  GitHubNotificationLifecycle,
  GitHubNotificationLifecycleBoundaryInput,
  GitHubNotificationLifecycleContextInput,
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

function issueUrl(item: GitHubNotificationLifecycleContextInput['item']): string {
  return `https://github.com/${encodeURIComponent(item.repositoryOwner)}/${encodeURIComponent(item.repositoryName)}/issues/${item.number}`;
}

function actorUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`;
}

/** Own issue-assignment intake and its required managed worktree. */
export default class GitHubIssueLifecycle implements GitHubNotificationLifecycle {
  readonly context = {
    project(input: GitHubNotificationLifecycleContextInput) {
      if (input.item.itemType !== 'issue' || !input.worktree) {
        throw new Error('The issue lifecycle context requires its prepared worktree.');
      }
      return {
        item: githubNotificationItemContext(input, 'issue'),
        worktree: input.worktree,
      };
    },
  };
  readonly eventSupport = {
    assignment: {
      session: {
        project(item: GitHubNotificationLifecycleContextInput['item']) {
          const actorLogin = item.assignmentActorLogin?.trim();
          const actorNodeId = item.assignmentActorNodeId?.trim();
          if (item.itemType !== 'issue' || !actorLogin || !actorNodeId) {
            throw new Error('The GitHub issue assignment is missing trusted assignment context.');
          }
          const repository = `${item.repositoryOwner}/${item.repositoryName}`;
          return {
            emoji: '📥',
            item: {
              kind: 'Issue',
              label: `${repository}#${item.number}`,
              url: issueUrl(item),
            },
            sender: { id: actorNodeId, label: actorLogin, url: actorUrl(actorLogin) },
            timestamp: item.lastObservedAt,
          };
        },
      },
    },
    comment: {},
  };
  readonly id = 'issue' as const;
  readonly instructions = githubNotificationIssueLifecycleInstructions;
  readonly modeSupport = { work: {} } as const;
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
