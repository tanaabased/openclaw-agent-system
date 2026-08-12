import { KeyedAsyncQueue } from 'openclaw/plugin-sdk/keyed-async-queue';

import type GitHubNotificationMonitorStateStore from './monitor-state-store.ts';
import {
  planGitHubNotificationDelivery,
  type GitHubNotificationDeliveryObservation,
  type GitHubNotificationObservedSession,
  type GitHubNotificationObservedWorktree,
} from '../utils/delivery-plan.ts';
import type {
  GitHubNotificationDeliveryState,
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from '../utils/monitor-state.ts';

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

/** Reconcile one agent's assignments serially through durable, value-free checkpoints. */
export default class GitHubNotificationAssignmentOrchestrator {
  readonly #dependencies: GitHubNotificationAssignmentOrchestratorDependencies;
  readonly #queue = new KeyedAsyncQueue();

  constructor(dependencies: GitHubNotificationAssignmentOrchestratorDependencies) {
    this.#dependencies = dependencies;
  }

  async reconcile(agentId: string, itemKey: string, signal?: AbortSignal): Promise<void> {
    return this.#queue.enqueue(agentId, () => this.#reconcile(agentId, itemKey, signal));
  }

  async #reconcile(agentId: string, itemKey: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#run(agentId, itemKey, signal);
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

      const observation = await this.#observe(agentId, state.workspaceDir, item, delivery, signal);
      const action = planGitHubNotificationDelivery(delivery, observation);
      if (action.kind === 'none') return;
      if (action.kind === 'fail') {
        throw new GitHubNotificationAssignmentOrchestratorError(
          action.reasonCode,
          'The GitHub notification briefing did not complete and will not be dispatched again.',
        );
      }
      if (action.kind === 'retire') {
        await this.#retire(state, itemKey, action.reasonCode);
        return;
      }
      if (action.kind === 'checkpoint-worktree') {
        await this.#checkpointWorktree(state, itemKey, action.worktree);
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
        )
          continue;
        const worktree = await this.#diagnosticBoundary(
          'github-notification-worktree-preparation-failed',
          'The notification worktree could not be prepared.',
          () =>
            this.#dependencies.worktrees.prepare({
              agentId,
              ...checkpoint,
              signal,
              workspaceDir: state.workspaceDir,
            }),
        );
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
      )
        continue;
      const session = await this.#diagnosticBoundary(
        'github-notification-briefing-dispatch-failed',
        'The notification briefing could not be dispatched.',
        () =>
          this.#dependencies.sessions.dispatchBriefing({
            agentId,
            ...checkpoint,
            signal,
            worktree,
            workspaceDir: state.workspaceDir,
          }),
      );
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
    const authority = await this.#diagnosticBoundary(
      'github-notification-authority-inspection-failed',
      'The notification assignment authority could not be inspected.',
      () =>
        this.#dependencies.authority.inspect({
          agentId,
          delivery,
          item,
          signal,
          workspaceDir,
        }),
    );
    if (authority.authorized && item.disposition !== 'retired' && delivery.stage === 'active') {
      return { authority };
    }
    const checkpointedWorktree =
      delivery.worktreeBranch && delivery.worktreePath
        ? { branch: delivery.worktreeBranch, path: delivery.worktreePath }
        : undefined;
    const worktree =
      !authority.authorized || item.disposition === 'retired'
        ? checkpointedWorktree
        : await this.#diagnosticBoundary(
            'github-notification-worktree-inspection-failed',
            'The notification worktree could not be inspected.',
            () =>
              this.#dependencies.worktrees.inspect({
                agentId,
                delivery,
                item,
                signal,
                workspaceDir,
              }),
          );
    if (!worktree) {
      return {
        authority,
        ...(item.disposition === 'retired'
          ? { retirementReasonCode: item.reasonCode, retirementRequested: true }
          : {}),
      };
    }
    return {
      authority,
      ...(item.disposition === 'retired'
        ? { retirementReasonCode: item.reasonCode, retirementRequested: true }
        : {}),
      worktree,
    };
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
    const authority = await this.#diagnosticBoundary(
      'github-notification-authority-inspection-failed',
      'The notification assignment authority could not be inspected.',
      () =>
        this.#dependencies.authority.inspect({
          agentId,
          delivery,
          item,
          signal,
          workspaceDir,
        }),
    );
    if (authority.authorized) return true;
    await this.#requestRetirement(
      state,
      itemKey,
      authority.reasonCode ?? 'github-notification-authority-revoked',
    );
    return false;
  }

  async #diagnosticBoundary<T>(
    code: string,
    message: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof GitHubNotificationAssignmentOrchestratorError) throw error;
      throw new GitHubNotificationAssignmentOrchestratorError(code, message, { cause: error });
    }
  }

  async #requestRetirement(
    state: GitHubNotificationMonitorState,
    itemKey: string,
    reasonCode: string,
  ): Promise<void> {
    const item = state.items[itemKey];
    if (!item?.delivery) return;
    if (item.disposition === 'retired' && item.reasonCode === reasonCode) return;
    state.items[itemKey] = { ...item, disposition: 'retired', reasonCode };
    await this.#writeState(state);
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
    const current = await this.#diagnosticBoundary(
      'github-notification-state-read-failed',
      'The notification assignment state could not be read.',
      () => this.#dependencies.stateStore.read(agentId),
    );
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
    await this.#checkpointDelivery(state, itemKey, {
      ...withoutFailure(delivery),
      sessionId: session.id,
      sessionKey: session.key,
      stage: 'active',
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
    await this.#writeState(state);
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
    await this.#writeState(state);
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

  async #writeState(state: GitHubNotificationMonitorState): Promise<void> {
    await this.#diagnosticBoundary(
      'github-notification-state-checkpoint-failed',
      'The notification assignment state could not be checkpointed.',
      () => this.#dependencies.stateStore.write(state),
    );
  }
}
