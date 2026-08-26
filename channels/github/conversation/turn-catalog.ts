import type GitHubNotificationEventRegistry from '../events/registry.ts';
import type { GitHubNotificationEventTurn } from '../events/types.ts';
import resolveGitHubNotificationLifecycleEventSupport from '../lifecycles/event-support.ts';
import type GitHubNotificationLifecycleRegistry from '../lifecycles/registry.ts';
import resolveGitHubNotificationLifecycleModeSupport from '../lifecycles/mode-support.ts';
import type {
  GitHubNotificationLifecycle,
  GitHubNotificationLifecycleModeSupport,
} from '../lifecycles/types.ts';
import type GitHubNotificationModeRegistry from '../modes/registry.ts';
import type { GitHubNotificationMode } from '../modes/types.ts';
import type { GitHubNotificationTurnIdentity } from './turn-identity.ts';

export interface GitHubNotificationTurnCatalogDependencies {
  events: Pick<GitHubNotificationEventRegistry, 'resolve'>;
  lifecycles: Pick<GitHubNotificationLifecycleRegistry, 'resolve'>;
  modes: Pick<GitHubNotificationModeRegistry, 'resolve'>;
}

export class GitHubNotificationTurnCatalogError extends Error {
  override name = 'GitHubNotificationTurnCatalogError';

  constructor(readonly code: string) {
    super('The GitHub notification model turn is not supported.');
  }
}

export interface GitHubNotificationTurnDefinition {
  readonly eventTurn: Extract<GitHubNotificationEventTurn, { kind: 'model' }>;
  readonly identity: Readonly<GitHubNotificationTurnIdentity>;
  readonly lifecycle: GitHubNotificationLifecycle;
  readonly mode: GitHubNotificationMode;
  readonly modeSupport: GitHubNotificationLifecycleModeSupport;
}

export const githubNotificationIssueWorkCommentTurnIdentity = {
  eventId: 'comment',
  lifecycleId: 'issue',
  modeId: 'work',
} as const satisfies GitHubNotificationTurnIdentity;

export const githubNotificationIssueWorkAssignmentTurnIdentity = {
  eventId: 'assignment',
  lifecycleId: 'issue',
  modeId: 'work',
} as const satisfies GitHubNotificationTurnIdentity;

export const githubNotificationIssueWorkImplementationTurnIdentity = {
  eventId: 'implementation',
  lifecycleId: 'issue',
  modeId: 'work',
} as const satisfies GitHubNotificationTurnIdentity;

export const githubNotificationIssueWorkPullRequestOpenedTurnIdentity = {
  eventId: 'pull-request-opened',
  lifecycleId: 'issue',
  modeId: 'work',
} as const satisfies GitHubNotificationTurnIdentity;

export const githubNotificationSupportedTurnIdentities = [
  githubNotificationIssueWorkAssignmentTurnIdentity,
  githubNotificationIssueWorkCommentTurnIdentity,
  githubNotificationIssueWorkImplementationTurnIdentity,
  githubNotificationIssueWorkPullRequestOpenedTurnIdentity,
] as const satisfies readonly GitHubNotificationTurnIdentity[];

function turnKey(identity: GitHubNotificationTurnIdentity): string {
  return `${identity.lifecycleId}:${identity.modeId}:${identity.eventId}`;
}

/** Admit only declared model-turn tuples and validate their shared definitions. */
export default class GitHubNotificationTurnCatalog {
  readonly #turns: ReadonlyMap<string, GitHubNotificationTurnDefinition>;

  constructor(
    turns: readonly GitHubNotificationTurnIdentity[],
    dependencies: GitHubNotificationTurnCatalogDependencies,
  ) {
    const entries: Array<[string, GitHubNotificationTurnDefinition]> = [];
    const keys = new Set<string>();
    for (const identity of turns) {
      const key = turnKey(identity);
      if (keys.has(key)) {
        throw new Error(`Duplicate GitHub notification model turn ${key}.`);
      }
      keys.add(key);

      const lifecycle = dependencies.lifecycles.resolve(identity.lifecycleId);
      const mode = dependencies.modes.resolve(identity.modeId);
      const event = dependencies.events.resolve(identity.eventId);
      const modeSupport = resolveGitHubNotificationLifecycleModeSupport(lifecycle, identity.modeId);
      resolveGitHubNotificationLifecycleEventSupport(lifecycle, identity.eventId);
      if (event.turn.kind !== 'model') {
        throw new GitHubNotificationTurnCatalogError('github-notification-turn-event-not-model');
      }
      entries.push([
        key,
        {
          eventTurn: event.turn,
          identity: { ...identity },
          lifecycle,
          mode,
          modeSupport,
        },
      ]);
    }
    this.#turns = new Map(entries);
  }

  resolve(identity: GitHubNotificationTurnIdentity): GitHubNotificationTurnDefinition {
    const turn = this.#turns.get(turnKey(identity));
    if (!turn) {
      throw new GitHubNotificationTurnCatalogError('github-notification-turn-unsupported');
    }
    return turn;
  }
}
