export type GitHubNotificationReplyCandidateTurn = symbol;

interface ActiveReplyCandidateTurn {
  candidates: string[];
  token: GitHubNotificationReplyCandidateTurn;
}

/** Hold typed public candidates only for the lifetime of one dispatched channel turn. */
export default class GitHubNotificationReplyCandidateStore {
  readonly #active = new Map<string, ActiveReplyCandidateTurn>();

  begin(sessionKey: string): GitHubNotificationReplyCandidateTurn {
    if (this.#active.has(sessionKey)) {
      throw new Error('A GitHub notification reply turn is already active for this session.');
    }
    const token = Symbol(sessionKey);
    this.#active.set(sessionKey, { candidates: [], token });
    return token;
  }

  cancel(sessionKey: string, token: GitHubNotificationReplyCandidateTurn): void {
    if (this.#active.get(sessionKey)?.token === token) this.#active.delete(sessionKey);
  }

  finish(sessionKey: string, token: GitHubNotificationReplyCandidateTurn): string[] {
    const active = this.#active.get(sessionKey);
    if (!active || active.token !== token) {
      throw new Error('The GitHub notification reply turn is no longer active.');
    }
    this.#active.delete(sessionKey);
    return [...active.candidates];
  }

  hasActive(sessionKey: string | undefined): boolean {
    return typeof sessionKey === 'string' && this.#active.has(sessionKey);
  }

  stage(sessionKey: string, candidate: string): void {
    const active = this.#active.get(sessionKey);
    if (!active) {
      throw new Error('No GitHub notification reply turn is active for this session.');
    }
    active.candidates.push(candidate);
  }
}
