import { randomUUID } from 'node:crypto';

import { parseGitHubNotificationMessageRequest } from './message-registry.ts';
import type { GitHubNotificationMessageRequest } from '../messages/types.ts';

export interface GitHubNotificationPromptInstructionRun {
  clear(): void;
  runId: string;
}

export interface GitHubNotificationPromptInstructionServiceDependencies {
  createRunId?(): string;
}

/** Correlate one notification instruction request with one admitted model run. */
export default class GitHubNotificationPromptInstructionService {
  readonly #createRunId: () => string;
  readonly #requests = new Map<string, GitHubNotificationMessageRequest>();

  public constructor(dependencies: GitHubNotificationPromptInstructionServiceDependencies = {}) {
    this.#createRunId = dependencies.createRunId ?? randomUUID;
  }

  public prepare(
    request: GitHubNotificationMessageRequest,
  ): GitHubNotificationPromptInstructionRun {
    const runId = this.#createRunId();
    this.#requests.set(runId, { ...request });
    return {
      clear: () => this.clear(runId),
      runId,
    };
  }

  public clear(runId: string | undefined): void {
    if (runId) this.#requests.delete(runId);
  }

  public resolve(runId: string | undefined): GitHubNotificationMessageRequest | undefined {
    if (!runId) return undefined;
    return parseGitHubNotificationMessageRequest(this.#requests.get(runId));
  }
}
