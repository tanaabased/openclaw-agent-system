import { randomUUID } from 'node:crypto';

const maximumInstructions = 16_000;

export interface GitHubNotificationPromptInstructionRun {
  clear(): void;
  runId: string;
}

export interface GitHubNotificationPromptInstructionServiceDependencies {
  createRunId?(): string;
}

/** Correlate hidden channel instructions with exactly one model run. */
export default class GitHubNotificationPromptInstructionService {
  readonly #createRunId: () => string;
  readonly #instructions = new Map<string, string>();

  constructor(dependencies: GitHubNotificationPromptInstructionServiceDependencies = {}) {
    this.#createRunId = dependencies.createRunId ?? randomUUID;
  }

  prepare(instructions: string): GitHubNotificationPromptInstructionRun {
    const normalized = instructions.trim();
    if (!normalized || normalized.length > maximumInstructions || normalized.includes('\0')) {
      throw new Error('GitHub notification prompt instructions are invalid.');
    }
    const runId = this.#createRunId();
    this.#instructions.set(runId, normalized);
    return { clear: () => this.clear(runId), runId };
  }

  clear(runId: string | undefined): void {
    if (runId) this.#instructions.delete(runId);
  }

  resolve(runId: string | undefined): string | undefined {
    return runId ? this.#instructions.get(runId) : undefined;
  }
}
