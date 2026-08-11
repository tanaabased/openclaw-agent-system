import type GitHubNotificationMonitorStateStore from '../channels/github/lib/monitor-state-store.ts';
import {
  planGitHubNotificationDelivery,
  type GitHubNotificationDeliveryObservation,
  type GitHubNotificationObservedSession,
  type GitHubNotificationObservedWorktree,
} from '../channels/github/utils/delivery-plan.ts';
import type {
  GitHubNotificationDeliveryState,
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../channels/github/utils/monitor-state.ts';

export interface GitHubNotificationAssignmentBoundaryInput {
  agentId: string;
  delivery: GitHubNotificationDeliveryState;
  item: GitHubNotificationItemState;
  signal?: AbortSignal;
  workspaceDir: string;
}

export interface GitHubNotificationAssignmentAuthority {
  inspect(
    input: GitHubNotificationAssignmentBoundaryInput,
  ): Promise<{ authorized: boolean; reasonCode?: string }>;
}

export interface GitHubNotificationAssignmentWorktrees {
  inspect(
    input: GitHubNotificationAssignmentBoundaryInput,
  ): Promise<GitHubNotificationObservedWorktree | undefined>;
  prepare(
    input: GitHubNotificationAssignmentBoundaryInput,
  ): Promise<GitHubNotificationObservedWorktree>;
}

export interface GitHubNotificationAssignmentSessionInput extends GitHubNotificationAssignmentBoundaryInput {
  worktree: GitHubNotificationObservedWorktree;
}

export interface GitHubNotificationAssignmentSessions {
  dispatchBriefing(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationObservedSession>;
  inspect(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationObservedSession | undefined>;
  prepare(
    input: GitHubNotificationAssignmentSessionInput,
  ): Promise<GitHubNotificationObservedSession>;
}

export interface GitHubNotificationAssignmentOrchestratorDependencies {
  authority: GitHubNotificationAssignmentAuthority;
  sessions: GitHubNotificationAssignmentSessions;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
  worktrees: GitHubNotificationAssignmentWorktrees;
}

export class GitHubNotificationAssignmentOrchestratorError extends Error {
  override name = 'GitHubNotificationAssignmentOrchestratorError';

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function withoutFailure(
  delivery: GitHubNotificationDeliveryState,
): GitHubNotificationDeliveryState {
  const next = { ...delivery };
  Reflect.deleteProperty(next, 'failureCode');
  return next;
}

function sessionStage(
  session: GitHubNotificationObservedSession,
): GitHubNotificationDeliveryState['stage'] {
  if (session.status === 'ready') return 'session-ready';
  return session.status;
}

/** Reconcile one agent's assignments serially through durable, value-free checkpoints. */
export default class GitHubNotificationAssignmentOrchestrator {
  readonly #dependencies: GitHubNotificationAssignmentOrchestratorDependencies;
  readonly #queues = new Map<string, Promise<void>>();

  constructor(dependencies: GitHubNotificationAssignmentOrchestratorDependencies) {
    this.#dependencies = dependencies;
  }

  async reconcile(agentId: string, itemKey: string, signal?: AbortSignal): Promise<void> {
    const previous = this.#queues.get(agentId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => this.#run(agentId, itemKey, signal));
    this.#queues.set(agentId, current);
    try {
      await current;
    } catch (error) {
      const code =
        error instanceof GitHubNotificationAssignmentOrchestratorError
          ? error.code
          : 'github-notification-delivery-failed';
      await this.#recordFailure(agentId, itemKey, code).catch(() => undefined);
      throw error instanceof GitHubNotificationAssignmentOrchestratorError
        ? error
        : new GitHubNotificationAssignmentOrchestratorError(
            code,
            'The GitHub notification assignment could not be reconciled.',
            { cause: error },
          );
    } finally {
      if (this.#queues.get(agentId) === current) this.#queues.delete(agentId);
    }
  }

  async #run(agentId: string, itemKey: string, signal?: AbortSignal): Promise<void> {
    for (let step = 0; step < 12; step += 1) {
      if (signal?.aborted) {
        throw new GitHubNotificationAssignmentOrchestratorError(
          'github-notification-delivery-aborted',
          'The GitHub notification assignment reconciliation was aborted.',
        );
      }
      const loaded = await this.#loadItem(agentId, itemKey);
      if (!loaded) return;
      const { delivery, item, state } = loaded;
      if (item.disposition === 'retired' && delivery.stage !== 'retired') {
        await this.#retire(state, itemKey, item.reasonCode);
        return;
      }

      const observation = await this.#observe(agentId, state.workspaceDir, item, delivery, signal);
      const action = planGitHubNotificationDelivery(delivery, observation);
      if (action.kind === 'none') return;
      if (action.kind === 'retire') {
        await this.#retire(state, itemKey, action.reasonCode);
        return;
      }
      if (action.kind === 'checkpoint-worktree') {
        await this.#checkpointWorktree(state, itemKey, action.worktree);
        continue;
      }
      if (action.kind === 'checkpoint-session') {
        await this.#checkpointSession(state, itemKey, action.session);
        continue;
      }
      if (action.kind === 'prepare-worktree') {
        await this.#checkpointDelivery(state, itemKey, {
          assignmentEventId: delivery.assignmentEventId,
          briefingIdempotencyKey: delivery.briefingIdempotencyKey,
          schemaVersion: 1,
          stage: 'admitted',
          workId: delivery.workId,
        });
        const checkpoint = this.#boundary(state, itemKey);
        if (!checkpoint) return;
        if (
          !(await this.#authorize(
            agentId,
            state.workspaceDir,
            checkpoint.item,
            checkpoint.delivery,
            signal,
            state,
            itemKey,
          ))
        ) {
          return;
        }
        const worktree = await this.#dependencies.worktrees.prepare({
          agentId,
          ...checkpoint,
          signal,
          workspaceDir: state.workspaceDir,
        });
        await this.#checkpointWorktree(state, itemKey, worktree);
        continue;
      }
      const worktree = observation.worktree;
      if (!worktree) {
        throw new GitHubNotificationAssignmentOrchestratorError(
          'github-notification-worktree-reconciliation-failed',
          'The GitHub notification worktree could not be reconciled.',
        );
      }
      if (action.kind === 'prepare-session') {
        await this.#checkpointWorktree(state, itemKey, worktree);
        const checkpoint = this.#boundary(state, itemKey);
        if (!checkpoint) return;
        if (
          !(await this.#authorize(
            agentId,
            state.workspaceDir,
            checkpoint.item,
            checkpoint.delivery,
            signal,
            state,
            itemKey,
          ))
        ) {
          return;
        }
        const session = await this.#dependencies.sessions.prepare({
          agentId,
          ...checkpoint,
          signal,
          worktree,
          workspaceDir: state.workspaceDir,
        });
        await this.#checkpointSession(state, itemKey, session);
        continue;
      }
      await this.#checkpointDelivery(state, itemKey, { ...delivery, stage: 'briefing-running' });
      const checkpoint = this.#boundary(state, itemKey);
      if (!checkpoint) return;
      if (
        !(await this.#authorize(
          agentId,
          state.workspaceDir,
          checkpoint.item,
          checkpoint.delivery,
          signal,
          state,
          itemKey,
        ))
      ) {
        return;
      }
      const session = await this.#dependencies.sessions.dispatchBriefing({
        agentId,
        ...checkpoint,
        signal,
        worktree,
        workspaceDir: state.workspaceDir,
      });
      await this.#checkpointSession(state, itemKey, session);
    }
    throw new GitHubNotificationAssignmentOrchestratorError(
      'github-notification-delivery-step-limit',
      'The GitHub notification assignment exceeded its reconciliation step limit.',
    );
  }

  async #observe(
    agentId: string,
    workspaceDir: string,
    item: GitHubNotificationItemState,
    delivery: GitHubNotificationDeliveryState,
    signal?: AbortSignal,
  ): Promise<GitHubNotificationDeliveryObservation> {
    const authority = await this.#dependencies.authority.inspect({
      agentId,
      delivery,
      item,
      signal,
      workspaceDir,
    });
    if (!authority.authorized) return { authority };
    const worktree = await this.#dependencies.worktrees.inspect({
      agentId,
      delivery,
      item,
      signal,
      workspaceDir,
    });
    if (!worktree) return { authority };
    const session = await this.#dependencies.sessions.inspect({
      agentId,
      delivery,
      item,
      signal,
      worktree,
      workspaceDir,
    });
    return { authority, ...(session ? { session } : {}), worktree };
  }

  async #authorize(
    agentId: string,
    workspaceDir: string,
    item: GitHubNotificationItemState,
    delivery: GitHubNotificationDeliveryState,
    signal: AbortSignal | undefined,
    state: GitHubNotificationMonitorState,
    itemKey: string,
  ): Promise<boolean> {
    const authority = await this.#dependencies.authority.inspect({
      agentId,
      delivery,
      item,
      signal,
      workspaceDir,
    });
    if (authority.authorized) return true;
    await this.#retire(
      state,
      itemKey,
      authority.reasonCode ?? 'github-notification-authority-revoked',
    );
    return false;
  }

  async #loadItem(
    agentId: string,
    itemKey: string,
  ): Promise<
    | {
        delivery: GitHubNotificationDeliveryState;
        item: GitHubNotificationItemState;
        state: GitHubNotificationMonitorState;
      }
    | undefined
  > {
    const current = await this.#dependencies.stateStore.read(agentId);
    if (!current) return undefined;
    const state = structuredClone(current);
    const item = state.items[itemKey];
    return item?.delivery ? { delivery: item.delivery, item, state } : undefined;
  }

  #boundary(
    state: GitHubNotificationMonitorState,
    itemKey: string,
  ): { delivery: GitHubNotificationDeliveryState; item: GitHubNotificationItemState } | undefined {
    const item = state.items[itemKey];
    return item?.delivery ? { delivery: item.delivery, item } : undefined;
  }

  async #checkpointWorktree(
    state: GitHubNotificationMonitorState,
    itemKey: string,
    worktree: GitHubNotificationObservedWorktree,
  ): Promise<void> {
    const delivery = state.items[itemKey]?.delivery;
    if (!delivery) return;
    const withoutSession = {
      ...withoutFailure(delivery),
      sessionId: undefined,
      sessionKey: undefined,
    };
    await this.#checkpointDelivery(state, itemKey, {
      ...withoutSession,
      stage: 'worktree-ready',
      worktreeBranch: worktree.branch,
      worktreePath: worktree.path,
    });
  }

  async #checkpointSession(
    state: GitHubNotificationMonitorState,
    itemKey: string,
    session: GitHubNotificationObservedSession,
  ): Promise<void> {
    const delivery = state.items[itemKey]?.delivery;
    if (!delivery) return;
    if (session.status === 'retired') {
      await this.#retire(state, itemKey, 'github-notification-session-retired');
      return;
    }
    await this.#checkpointDelivery(state, itemKey, {
      ...withoutFailure(delivery),
      sessionId: session.id,
      sessionKey: session.key,
      stage: sessionStage(session),
    });
  }

  async #checkpointDelivery(
    state: GitHubNotificationMonitorState,
    itemKey: string,
    delivery: GitHubNotificationDeliveryState,
  ): Promise<void> {
    const item = state.items[itemKey];
    if (!item) return;
    state.items[itemKey] = { ...item, delivery: withoutFailure(delivery) };
    await this.#dependencies.stateStore.write(state);
  }

  async #retire(
    state: GitHubNotificationMonitorState,
    itemKey: string,
    reasonCode: string,
  ): Promise<void> {
    const item = state.items[itemKey];
    if (!item?.delivery) return;
    state.items[itemKey] = {
      ...item,
      delivery: { ...withoutFailure(item.delivery), stage: 'retired' },
      disposition: 'retired',
      reasonCode,
    };
    await this.#dependencies.stateStore.write(state);
  }

  async #recordFailure(agentId: string, itemKey: string, code: string): Promise<void> {
    const loaded = await this.#loadItem(agentId, itemKey);
    if (!loaded) return;
    loaded.state.items[itemKey] = {
      ...loaded.item,
      delivery: { ...loaded.delivery, failureCode: code },
    };
    await this.#dependencies.stateStore.write(loaded.state);
  }
}
