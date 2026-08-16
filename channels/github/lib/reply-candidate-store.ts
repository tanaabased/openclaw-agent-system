export type GitHubNotificationReplyCandidateTurn = symbol;

interface ActiveReplyCandidateTurn {
  candidates: string[];
  token: GitHubNotificationReplyCandidateTurn;
}

/** Hold typed public candidates only for the lifetime of one dispatched channel turn. */
export default class GitHubNotificationReplyCandidateStore {
  readonly #active = new Map<string, ActiveReplyCandidateTurn>();

  begin(agentId: string): GitHubNotificationReplyCandidateTurn {
    if (this.#active.has(agentId)) {
      throw new Error('A GitHub notification reply turn is already active for this agent.');
    }
    const token = Symbol(agentId);
    this.#active.set(agentId, { candidates: [], token });
    return token;
  }

  cancel(agentId: string, token: GitHubNotificationReplyCandidateTurn): void {
    if (this.#active.get(agentId)?.token === token) this.#active.delete(agentId);
  }

  finish(agentId: string, token: GitHubNotificationReplyCandidateTurn): string[] {
    const active = this.#active.get(agentId);
    if (!active || active.token !== token) {
      throw new Error('The GitHub notification reply turn is no longer active.');
    }
    this.#active.delete(agentId);
    return [...active.candidates];
  }

  hasActive(agentId: string | undefined): boolean {
    return typeof agentId === 'string' && this.#active.has(agentId);
  }

  stage(agentId: string, candidate: string): void {
    const active = this.#active.get(agentId);
    if (!active) {
      throw new Error('No matching GitHub notification reply turn is active for this agent.');
    }
    active.candidates.push(candidate);
  }
}
