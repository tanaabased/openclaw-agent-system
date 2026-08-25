export interface GitHubNotificationSessionEntry {
  archivedAt?: number;
  pinnedAt?: number;
}

export interface GitHubNotificationSessionRuntime {
  getSessionEntry(input: {
    agentId: string;
    sessionKey: string;
  }): GitHubNotificationSessionEntry | undefined;
  patchSessionEntry(input: {
    agentId: string;
    preserveActivity: true;
    sessionKey: string;
    update(entry: GitHubNotificationSessionEntry): Partial<GitHubNotificationSessionEntry>;
  }): Promise<unknown>;
}

/** Archive one canonical OpenClaw session while atomically respecting a user pin. */
export default class GitHubNotificationSessionArchiveService {
  readonly #clock: () => number;
  readonly #runtime: GitHubNotificationSessionRuntime;

  constructor(dependencies: { clock?: () => number; runtime: GitHubNotificationSessionRuntime }) {
    this.#clock = dependencies.clock ?? Date.now;
    this.#runtime = dependencies.runtime;
  }

  async archive(agentId: string, sessionKey: string): Promise<'archived' | 'missing' | 'pinned'> {
    const current = this.#runtime.getSessionEntry({ agentId, sessionKey });
    if (!current) return 'missing';
    if (current.pinnedAt !== undefined) return 'pinned';
    if (current.archivedAt !== undefined) return 'archived';

    let outcome: 'archived' | 'missing' | 'pinned' = 'missing';
    await this.#runtime.patchSessionEntry({
      agentId,
      preserveActivity: true,
      sessionKey,
      update: (entry) => {
        if (entry.pinnedAt !== undefined) {
          outcome = 'pinned';
          return {};
        }
        outcome = 'archived';
        return entry.archivedAt === undefined ? { archivedAt: this.#clock() } : {};
      },
    });
    return outcome;
  }
}
