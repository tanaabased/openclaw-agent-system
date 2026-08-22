import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type GitHubNotificationEventRegistry from '../events/registry.ts';
import type GitHubNotificationLifecycleRegistry from '../lifecycles/registry.ts';
import resolveGitHubNotificationLifecycleModeSupport from '../lifecycles/mode-support.ts';
import type { GitHubNotificationLifecycle } from '../lifecycles/types.ts';
import type GitHubNotificationModeRegistry from '../modes/registry.ts';
import type { ResolvedGitHubNotificationMode } from '../modes/types.ts';
import composeGitHubNotificationPrompt from './prompts/compose.ts';
import type { GitHubNotificationTurnIdentity } from './turn-identity.ts';

export interface GitHubNotificationTurnContract {
  identity: GitHubNotificationTurnIdentity;
  instructions: string;
  lifecycle: GitHubNotificationLifecycle;
  mode: ResolvedGitHubNotificationMode;
}

export interface GitHubNotificationTurnModelOptions {
  disableTools: boolean;
  toolsAllow?: string[];
}

export interface GitHubNotificationTurnDispatchOptions {
  replyOptions: GitHubNotificationTurnModelOptions;
  toolsAllow?: string[];
}

export interface GitHubNotificationTurnContractResolverDependencies {
  events: Pick<GitHubNotificationEventRegistry, 'resolve'>;
  lifecycles: Pick<GitHubNotificationLifecycleRegistry, 'resolve'>;
  modes: Pick<GitHubNotificationModeRegistry, 'resolve'>;
}

export class GitHubNotificationTurnContractError extends Error {
  override name = 'GitHubNotificationTurnContractError';

  constructor(readonly code: string) {
    super('The GitHub notification turn contract is unavailable.');
  }
}

/** Project one resolved turn contract into the channel dispatch boundary. */
export function githubNotificationTurnDispatchOptions(
  contract: Pick<GitHubNotificationTurnContract, 'mode'>,
): GitHubNotificationTurnDispatchOptions {
  const replyOptions: GitHubNotificationTurnModelOptions = {
    disableTools: contract.mode.disableTools,
    ...(contract.mode.toolsAllow === undefined
      ? {}
      : { toolsAllow: [...contract.mode.toolsAllow] }),
  };
  return {
    replyOptions,
    ...(replyOptions.toolsAllow === undefined ? {} : { toolsAllow: replyOptions.toolsAllow }),
  };
}

/** Resolve trusted lifecycle, mode, prompt, and capability for one turn. */
export default class GitHubNotificationTurnContractResolver {
  readonly #dependencies: GitHubNotificationTurnContractResolverDependencies;

  constructor(dependencies: GitHubNotificationTurnContractResolverDependencies) {
    this.#dependencies = dependencies;
  }

  instructions(identity: GitHubNotificationTurnIdentity): string {
    const lifecycle = this.#dependencies.lifecycles.resolve(identity.lifecycleId);
    const mode = this.#dependencies.modes.resolve(identity.modeId);
    const support = resolveGitHubNotificationLifecycleModeSupport(lifecycle, identity.modeId);
    const event = this.#dependencies.events.resolve(identity.eventId);
    if (event.turn.kind !== 'model') {
      throw new GitHubNotificationTurnContractError('github-notification-event-unimplemented');
    }
    return composeGitHubNotificationPrompt({
      eventInstructions: event.turn.instructions,
      lifecycleInstructions: lifecycle.instructions,
      modeInstructions: mode.instructions,
      ...(support.instructions === undefined
        ? {}
        : { modeLifecycleInstructions: support.instructions }),
      responseInstructions: event.turn.responseInstructions,
    });
  }

  resolve(
    identity: GitHubNotificationTurnIdentity,
    config: OpenClawConfig,
    agentId: string,
  ): GitHubNotificationTurnContract {
    const lifecycle = this.#dependencies.lifecycles.resolve(identity.lifecycleId);
    const mode = this.#dependencies.modes.resolve(identity.modeId).resolve(config, agentId);
    return {
      identity,
      instructions: this.instructions(identity),
      lifecycle,
      mode,
    };
  }
}
