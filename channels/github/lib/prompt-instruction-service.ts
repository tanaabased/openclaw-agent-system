import { randomUUID } from 'node:crypto';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import { parseGitHubNotificationMessageRequest } from './message-registry.ts';
import type { GitHubNotificationMessageRequest } from '../messages/types.ts';

const githubNotificationPromptInstructionNamespace = 'github-notification-message';

type GitHubNotificationRunContext = Pick<
  OpenClawPluginApi['runContext'],
  'clearRunContext' | 'getRunContext' | 'setRunContext'
>;

export interface GitHubNotificationPromptInstructionRun {
  adopt(): void;
  clear(): void;
  runId: string;
}

export interface GitHubNotificationPromptInstructionServiceDependencies {
  createRunId?(): string;
  runContext: GitHubNotificationRunContext;
}

export class GitHubNotificationPromptInstructionServiceError extends Error {
  public readonly code = 'github-notification-instruction-context-unavailable';
}

/** Correlate one notification instruction request with one admitted model run. */
export default class GitHubNotificationPromptInstructionService {
  readonly #createRunId: () => string;
  readonly #runContext: GitHubNotificationRunContext;

  public constructor(dependencies: GitHubNotificationPromptInstructionServiceDependencies) {
    this.#createRunId = dependencies.createRunId ?? randomUUID;
    this.#runContext = dependencies.runContext;
  }

  public prepare(
    request: GitHubNotificationMessageRequest,
  ): GitHubNotificationPromptInstructionRun {
    const runId = this.#createRunId();
    let adopted = false;
    return {
      adopt: () => {
        if (adopted) return;
        const stored = this.#runContext.setRunContext({
          namespace: githubNotificationPromptInstructionNamespace,
          runId,
          value: {
            assignmentKind: request.assignmentKind,
            event: request.event,
            mode: request.mode,
          },
        });
        if (!stored) {
          throw new GitHubNotificationPromptInstructionServiceError(
            'OpenClaw did not accept the GitHub notification prompt instruction context.',
          );
        }
        adopted = true;
      },
      clear: () => {
        if (!adopted) return;
        this.#runContext.clearRunContext({
          namespace: githubNotificationPromptInstructionNamespace,
          runId,
        });
        adopted = false;
      },
      runId,
    };
  }

  public resolve(runId: string | undefined): GitHubNotificationMessageRequest | undefined {
    if (!runId) return undefined;
    return parseGitHubNotificationMessageRequest(
      this.#runContext.getRunContext({
        namespace: githubNotificationPromptInstructionNamespace,
        runId,
      }),
    );
  }
}
