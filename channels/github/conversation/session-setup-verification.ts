import type { Logger } from '../../../core/logger.ts';

export interface SessionSetupEntry {
  owner?: { actor: { type: 'agent' | 'human' | 'system'; id?: string } };
  color?: string;
  category?: string;
}

export interface SessionSetupReader {
  getSessionEntry(input: {
    agentId: string;
    sessionKey: string;
    readConsistency: 'latest';
  }): SessionSetupEntry | undefined;
}

export interface SessionSetupToolEvent {
  toolName: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

interface Observation {
  group?: string;
  ownerAssigned?: boolean;
  failure?: 'owner-denied' | 'tool-denied' | 'tool-unavailable' | 'tool-failed';
}

const colors = new Set(['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan']);

function complete(entry: SessionSetupEntry | undefined, agentId: string): boolean {
  return (
    entry?.owner?.actor.type === 'agent' &&
    entry.owner.actor.id === agentId &&
    colors.has(entry.color ?? '') &&
    typeof entry.category === 'string' &&
    entry.category.trim().length > 0
  );
}

function key(input: { agentId: string; sessionKey: string }): string {
  return JSON.stringify([input.agentId, input.sessionKey.toLowerCase()]);
}

/** Observe only an active initial turn; persisted host state, not model prose, is the evidence. */
export default class SessionSetupVerification {
  readonly #observations = new Map<string, Observation>();

  constructor(
    readonly dependencies: { runtime: SessionSetupReader; logger: Pick<Logger, 'info' | 'warn'> },
  ) {}

  observe(event: SessionSetupToolEvent, context: { agentId?: string; sessionKey?: string }): void {
    if (event.toolName !== 'sessions' || !context.agentId || !context.sessionKey) return;
    const observation = this.#observations.get(
      key({ agentId: context.agentId, sessionKey: context.sessionKey }),
    );
    if (!observation || event.params.sessionKey !== undefined || event.params.targets !== undefined)
      return;
    const result =
      event.result && typeof event.result === 'object'
        ? (event.result as Record<string, unknown>)
        : undefined;
    const details =
      result?.details && typeof result.details === 'object'
        ? (result.details as Record<string, unknown>)
        : result;
    const failedStatus = ['error', 'forbidden', 'denied'].includes(String(details?.status ?? ''));
    if (event.error || result?.isError === true || failedStatus) {
      // classify bounded failure text without retaining or logging the host's raw result.
      const content = Array.isArray(result?.content)
        ? result.content
            .slice(0, 4)
            .flatMap((part) =>
              part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
                ? [part.text.slice(0, 512)]
                : [],
            )
            .join(' ')
        : '';
      const reason =
        `${event.error?.slice(0, 2048) ?? ''} ${typeof details?.error === 'string' ? details.error.slice(0, 512) : ''} ${content}`.toLowerCase();
      observation.failure = /owner/.test(reason)
        ? 'owner-denied'
        : /denied|not allowed|policy/.test(reason)
          ? 'tool-denied'
          : /unavailable|not found/.test(reason)
            ? 'tool-unavailable'
            : 'tool-failed';
      return;
    }
    if (
      event.params.action === 'assign_owner' &&
      event.params.ownerType === 'agent' &&
      event.params.ownerId === context.agentId
    )
      observation.ownerAssigned = true;
    if (
      event.params.action === 'patch' &&
      typeof event.params.group === 'string' &&
      event.params.group.trim().length > 0 &&
      event.params.group.length <= 100
    )
      observation.group = event.params.group.trim();
  }

  async run<T>(input: { agentId: string; sessionKey: string }, turn: () => Promise<T>): Promise<T> {
    const id = key(input);
    const observation: Observation = {};
    let before: SessionSetupEntry | undefined;
    try {
      const entry = this.dependencies.runtime.getSessionEntry({
        ...input,
        readConsistency: 'latest',
      });
      before = entry
        ? { owner: structuredClone(entry.owner), color: entry.color, category: entry.category }
        : undefined;
    } catch {
      /* optional state */
    }
    this.#observations.set(id, observation);
    try {
      return await turn();
    } finally {
      this.#observations.delete(id);
      try {
        const entry = this.dependencies.runtime.getSessionEntry({
          ...input,
          readConsistency: 'latest',
        });
        const details = `agent=${input.agentId}`;
        if (complete(entry, input.agentId)) {
          const preserved =
            complete(before, input.agentId) &&
            before?.category === entry?.category &&
            before?.color === entry?.color;
          if (preserved)
            this.dependencies.logger.info(
              `github-notifications: session setup preserved ${details}; existing values are not proof of automation`,
            );
          else if (
            observation.ownerAssigned &&
            observation.group === entry?.category &&
            !observation.failure
          )
            this.dependencies.logger.info(
              `github-notifications: session setup verified ${details}`,
            );
          else
            this.dependencies.logger.warn(
              `github-notifications: session setup unverifiable ${details} code=${observation.failure ?? 'tool-evidence-unavailable'}; persisted fields exist but automated setup is unproven`,
            );
        } else {
          this.dependencies.logger.warn(
            `github-notifications: session setup incomplete ${details} code=${observation.failure ?? 'setup-missing'} owner=${entry?.owner?.actor.type === 'agent' && entry.owner.actor.id === input.agentId} color=${colors.has(entry?.color ?? '')} group=${Boolean(entry?.category?.trim())}; work continues`,
          );
        }
      } catch {
        this.dependencies.logger.warn(
          `github-notifications: session setup unverifiable agent=${input.agentId} code=${observation.failure ?? 'state-unreadable'}; work continues`,
        );
      }
    }
  }
}
