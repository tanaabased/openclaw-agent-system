import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-types';

import type { GitHubNotificationLifecycle } from '../lifecycles/types.ts';
import resolveGitHubNotificationModeCapability from '../modes/capability.ts';
import type { ResolvedGitHubNotificationMode } from '../modes/types.ts';
import type { GitHubNotificationPublicationIntent } from '../publication/publication.ts';
import composeGitHubNotificationPrompt from './prompts/compose.ts';
import type GitHubNotificationTurnCatalog from './turn-catalog.ts';
import type { GitHubNotificationTurnDefinition } from './turn-catalog.ts';
import type { GitHubNotificationTurnIdentity } from './turn-identity.ts';

export interface GitHubNotificationTurnContract {
  identity: GitHubNotificationTurnIdentity;
  instructions: string;
  lifecycle: GitHubNotificationLifecycle;
  mode: ResolvedGitHubNotificationMode;
  publicationIntent?: GitHubNotificationPublicationIntent;
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
  turns: Pick<GitHubNotificationTurnCatalog, 'resolve'>;
}

function turnInstructions(turn: GitHubNotificationTurnDefinition): string {
  return composeGitHubNotificationPrompt({
    eventInstructions: turn.eventTurn.instructions,
    lifecycleInstructions: turn.lifecycle.instructions,
    modeInstructions: turn.mode.instructions,
    ...(turn.modeSupport.instructions === undefined
      ? {}
      : { modeLifecycleInstructions: turn.modeSupport.instructions }),
    responseInstructions: turn.eventTurn.responseInstructions,
  });
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
    return turnInstructions(this.#dependencies.turns.resolve(identity));
  }

  resolve(
    identity: GitHubNotificationTurnIdentity,
    config: OpenClawConfig,
    agentId: string,
  ): GitHubNotificationTurnContract {
    const turn = this.#dependencies.turns.resolve(identity);
    const publicationIntent =
      identity.eventId === 'assignment' &&
      turn.mode.policy.assignmentContinuation === 'wait-for-input'
        ? undefined
        : turn.eventTurn.publicationIntent;
    return {
      identity: turn.identity,
      instructions: turnInstructions(turn),
      lifecycle: turn.lifecycle,
      mode: resolveGitHubNotificationModeCapability(turn.mode, config, agentId),
      ...(publicationIntent === undefined ? {} : { publicationIntent }),
    };
  }
}
