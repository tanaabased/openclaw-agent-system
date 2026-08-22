import type { PluginHookAgentContext } from 'openclaw/plugin-sdk/types';

import { githubNotificationChannelId } from '../routing/routing.ts';
import type { GitHubNotificationTurnContract } from './turn-contract.ts';

interface ActiveGitHubNotificationPrompt {
  contract: Pick<GitHubNotificationTurnContract, 'identity' | 'instructions'>;
  observed: boolean;
  token: symbol;
}

export class GitHubNotificationPromptGuidanceError extends Error {
  override name = 'GitHubNotificationPromptGuidanceError';

  constructor(readonly code: string) {
    super('The GitHub notification prompt guidance is unavailable.');
  }
}

/**
 * Scope one resolved turn contract to the existing prompt-build hook mechanism.
 * The session key is the stable cross-harness correlation; Codex prompt hooks do
 * not preserve arbitrary channel-context metadata.
 */
export default class GitHubNotificationPromptGuidance {
  readonly #active = new Map<string, ActiveGitHubNotificationPrompt>();

  instructions(context: PluginHookAgentContext): string | undefined {
    if (context.messageProvider !== githubNotificationChannelId) return undefined;
    const sessionKey = context.sessionKey?.trim();
    const active = sessionKey ? this.#active.get(sessionKey) : undefined;
    if (!active) {
      throw new GitHubNotificationPromptGuidanceError(
        'github-notification-turn-prompt-scope-missing',
      );
    }
    active.observed = true;
    return active.contract.instructions;
  }

  async withTurn<T>(
    sessionKey: string,
    contract: Pick<GitHubNotificationTurnContract, 'identity' | 'instructions'>,
    dispatch: () => Promise<T>,
  ): Promise<T> {
    const normalizedSessionKey = sessionKey.trim();
    if (!normalizedSessionKey || !contract.instructions.trim()) {
      throw new GitHubNotificationPromptGuidanceError(
        'github-notification-turn-prompt-scope-invalid',
      );
    }
    if (this.#active.has(normalizedSessionKey)) {
      throw new GitHubNotificationPromptGuidanceError(
        'github-notification-turn-prompt-scope-conflict',
      );
    }
    const active: ActiveGitHubNotificationPrompt = {
      contract,
      observed: false,
      token: Symbol(normalizedSessionKey),
    };
    this.#active.set(normalizedSessionKey, active);
    try {
      const result = await dispatch();
      if (!active.observed) {
        throw new GitHubNotificationPromptGuidanceError(
          'github-notification-turn-prompt-unobserved',
        );
      }
      return result;
    } finally {
      if (this.#active.get(normalizedSessionKey)?.token === active.token) {
        this.#active.delete(normalizedSessionKey);
      }
    }
  }
}
