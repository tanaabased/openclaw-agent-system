import { KeyedAsyncQueue } from 'openclaw/plugin-sdk/keyed-async-queue';

import type GitHubNotificationLifecycleRegistry from '../lifecycles/registry.ts';
import type GitHubNotificationAssignmentSessionService from '../conversation/assignment-session-service.ts';
import type { GitHubNotificationMode } from '../modes/types.ts';
import type {
  GitHubNotificationLifecycle,
  GitHubNotificationLifecycleBoundaryInput,
  GitHubNotificationLifecycleWorktree,
} from '../lifecycles/types.ts';
import type GitHubNotificationMonitorStateStore from './monitor/state-store.ts';
import planGitHubNotificationIntake, {
  type GitHubNotificationIntakeObservation,
} from './intake-plan.ts';
import type {
  GitHubNotificationIntakeState,
  GitHubNotificationItemState,
  GitHubNotificationMonitorState,
} from './monitor/state.ts';

export interface GitHubNotificationAssignmentAuthority {
  inspect(
    input: GitHubNotificationLifecycleBoundaryInput,
  ): Promise<{ authorized: boolean; reasonCode?: string }>;
}

export interface GitHubNotificationAssignmentOrchestratorDependencies {
  authority: GitHubNotificationAssignmentAuthority;
  initialMode: Pick<GitHubNotificationMode, 'policy'>;
  lifecycles: GitHubNotificationLifecycleRegistry;
  sessions: Pick<GitHubNotificationAssignmentSessionService, 'prepare'>;
  stateStore: Pick<GitHubNotificationMonitorStateStore, 'read' | 'write'>;
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

function withoutFailure(intake: GitHubNotificationIntakeState): GitHubNotificationIntakeState {
  const next = { ...intake };
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

  async #reconcile(
    agentId: string,
    itemKey: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await this.#run(agentId, itemKey, signal);
    } catch (error) {
      const code =
        error instanceof GitHubNotificationAssignmentOrchestratorError
          ? error.code
          : 'github-notification-intake-failed';
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

  async #run(agentId: string, itemKey: string, signal: AbortSignal | undefined): Promise<void> {
    for (let step = 0; step < 12; step += 1) {
      if (signal?.aborted) {
        throw new GitHubNotificationAssignmentOrchestratorError(
          'github-notification-intake-aborted',
          'The GitHub notification assignment reconciliation was aborted.',
        );
      }
      const loaded = await this.#loadItem(agentId, itemKey);
      if (!loaded) return;
      const { intake, item, state } = loaded;
      const lifecycle = this.#dependencies.lifecycles.resolve(item.lifecycleId);

      const observation = await this.#observe(
        lifecycle,
        agentId,
        state.workspaceDir,
        item,
        intake,
        signal,
      );
      const action = planGitHubNotificationIntake(intake, observation, lifecycle.worktree.required);
      if (action.kind === 'none') return;
      if (action.kind === 'retire') {
        await this.#retire(state, itemKey, action.reasonCode);
        return;
      }
      if (action.kind === 'mark-prepared') {
        await this.#checkpointPrepared(agentId, state, itemKey, action.worktree);
        return;
      }
      if (action.kind === 'prepare-worktree') {
        const checkpoint = this.#boundary(state, itemKey);
        if (!checkpoint) return;
        if (
          !(await this.#authorize(
            agentId,
            state.workspaceDir,
            checkpoint.item,
            checkpoint.intake,
            signal,
            state,
            itemKey,
          ))
        )
          continue;
        const worktreeOwner = lifecycle.worktree;
        if (!worktreeOwner.required) {
          throw new GitHubNotificationAssignmentOrchestratorError(
            'github-notification-lifecycle-invalid',
            'The GitHub notification lifecycle requested an unsupported worktree action.',
          );
        }
        const worktree = await this.#diagnosticBoundary(
          'github-notification-worktree-preparation-failed',
          'The notification worktree could not be prepared.',
          () =>
            worktreeOwner.prepare({
              agentId,
              ...checkpoint,
              signal,
              workspaceDir: state.workspaceDir,
            }),
        );
        await this.#checkpointPrepared(agentId, state, itemKey, worktree);
        return;
      }
      continue;
    }
    throw new GitHubNotificationAssignmentOrchestratorError(
      'github-notification-intake-step-limit',
      'The GitHub notification assignment exceeded its reconciliation step limit.',
    );
  }

  async #observe(
    lifecycle: GitHubNotificationLifecycle,
    agentId: string,
    workspaceDir: string,
    item: GitHubNotificationItemState,
    intake: GitHubNotificationIntakeState,
    signal?: AbortSignal,
  ): Promise<GitHubNotificationIntakeObservation> {
    const authority = await this.#diagnosticBoundary(
      'github-notification-authority-inspection-failed',
      'The notification assignment authority could not be inspected.',
      () =>
        this.#dependencies.authority.inspect({
          agentId,
          intake,
          item,
          signal,
          workspaceDir,
        }),
    );
    const checkpointedWorktree =
      intake.worktreeBranch && intake.worktreePath
        ? { branch: intake.worktreeBranch, path: intake.worktreePath }
        : undefined;
    const worktreeOwner = lifecycle.worktree;
    const worktree =
      !authority.authorized || item.disposition === 'retired'
        ? checkpointedWorktree
        : !worktreeOwner.required
          ? checkpointedWorktree
          : await this.#diagnosticBoundary(
              'github-notification-worktree-inspection-failed',
              'The notification worktree could not be inspected.',
              () =>
                worktreeOwner.inspect({
                  agentId,
                  intake,
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
    intake: GitHubNotificationIntakeState,
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
          intake,
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
    if (!item?.intake) return;
    if (item.disposition === 'retired' && item.reasonCode === reasonCode) return;
    state.items[itemKey] = { ...item, disposition: 'retired', reasonCode };
    await this.#writeState(state);
  }

  async #loadItem(
    agentId: string,
    itemKey: string,
  ): Promise<
    | {
        intake: GitHubNotificationIntakeState;
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
    return item?.intake ? { intake: item.intake, item, state } : undefined;
  }

  #boundary(
    state: GitHubNotificationMonitorState,
    itemKey: string,
  ): { intake: GitHubNotificationIntakeState; item: GitHubNotificationItemState } | undefined {
    const item = state.items[itemKey];
    return item?.intake ? { intake: item.intake, item } : undefined;
  }

  async #checkpointPrepared(
    agentId: string,
    state: GitHubNotificationMonitorState,
    itemKey: string,
    worktree?: GitHubNotificationLifecycleWorktree,
  ): Promise<void> {
    const item = state.items[itemKey];
    const intake = item?.intake;
    if (!item || !intake) return;
    const lifecycle = this.#dependencies.lifecycles.resolve(item.lifecycleId);
    if (lifecycle.assignmentSession.enabled) {
      const preparedWorktree =
        worktree ??
        (intake.worktreeBranch && intake.worktreePath
          ? { branch: intake.worktreeBranch, path: intake.worktreePath }
          : undefined);
      if (lifecycle.worktree.required && !preparedWorktree) {
        throw new GitHubNotificationAssignmentOrchestratorError(
          'github-notification-assignment-session-context-missing',
          'The GitHub assignment session is missing its lifecycle context.',
        );
      }
      await this.#diagnosticBoundary(
        'github-notification-assignment-session-recording-failed',
        'The GitHub assignment session could not be prepared.',
        () =>
          this.#dependencies.sessions.prepare({
            agentId,
            item,
            lifecycle,
            mode: this.#dependencies.initialMode,
            workspaceDir: state.workspaceDir,
            ...(preparedWorktree === undefined ? {} : { worktree: preparedWorktree }),
          }),
      );
    }
    await this.#checkpointIntake(state, itemKey, {
      ...withoutFailure(intake),
      stage: 'prepared',
      ...(worktree === undefined
        ? {}
        : { worktreeBranch: worktree.branch, worktreePath: worktree.path }),
    });
  }

  async #checkpointIntake(
    state: GitHubNotificationMonitorState,
    itemKey: string,
    intake: GitHubNotificationIntakeState,
  ): Promise<void> {
    const item = state.items[itemKey];
    if (!item) return;
    state.items[itemKey] = { ...item, intake: withoutFailure(intake) };
    await this.#writeState(state);
  }

  async #retire(
    state: GitHubNotificationMonitorState,
    itemKey: string,
    reasonCode: string,
  ): Promise<void> {
    const item = state.items[itemKey];
    if (!item?.intake) return;
    state.items[itemKey] = {
      ...item,
      intake: { ...withoutFailure(item.intake), stage: 'retired' },
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
      intake: { ...loaded.intake, failureCode: code },
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
