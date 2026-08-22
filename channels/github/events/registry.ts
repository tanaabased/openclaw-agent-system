import type { GitHubNotificationEvent, GitHubNotificationEventId } from './types.ts';

/** Resolve only explicitly registered GitHub notification events. */
export default class GitHubNotificationEventRegistry {
  readonly #events: ReadonlyMap<GitHubNotificationEventId, GitHubNotificationEvent>;

  constructor(events: readonly GitHubNotificationEvent[]) {
    const entries: Array<[GitHubNotificationEventId, GitHubNotificationEvent]> = [];
    const ids = new Set<GitHubNotificationEventId>();
    for (const event of events) {
      if (ids.has(event.id)) {
        throw new Error(`Duplicate GitHub notification event ${event.id}.`);
      }
      ids.add(event.id);
      entries.push([event.id, event]);
    }
    this.#events = new Map(entries);
  }

  resolve(id: GitHubNotificationEventId): GitHubNotificationEvent {
    const event = this.#events.get(id);
    if (!event) throw new Error(`GitHub notification event ${id} is not implemented.`);
    return event;
  }
}
