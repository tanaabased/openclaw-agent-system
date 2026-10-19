import { type default as assignmentIntakePolicy } from './assignment-intake-policy.ts';
import {
  githubNotificationRuntimeBlocker,
  githubNotificationRuntimeDiagnostics,
} from '../channels/github/notification-policy.ts';
import dispatchCapacity from './openclaw-capacity.ts';
import pendingDispatchAssignments, { issueKey } from './dispatch-pending.ts';
import OpenClawDispatchStore, { type OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import {
  evaluateGitHubNotificationWait,
  type GitHubNotificationItemSelector,
  type GitHubNotificationRefreshResult,
  type GitHubNotificationStatusResult,
  type GitHubNotificationWaitTarget,
  type GitHubNotificationWaitResult,
} from '../channels/github/cli/contracts.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';
import type { AgentManifest } from '../manifest/types.ts';
import abortableDelay from '../utils/abortable-delay.ts';

export type NotificationRefreshResult = GitHubNotificationRefreshResult;

interface Dependencies {
  root: string;
  intake: {
    readiness(manifest: AgentManifest, workspace: string): Promise<string | undefined>;
    select(
      manifest: AgentManifest,
      workspace: string,
    ): Promise<{
      selected: ReturnType<typeof assignmentIntakePolicy>;
      store: { location: { scope: string }; read(): Promise<IntakeState | undefined> };
    }>;
  };
  requestRun(
    manifest: AgentManifest,
    workspace: string,
    signal: AbortSignal,
  ): Promise<{
    status: 'queued' | 'skipped';
    runId?: string;
    reason?: string;
  }>;
  scanSelected(
    manifest: AgentManifest,
    workspace: string,
    selector: GitHubNotificationItemSelector,
    signal: AbortSignal,
  ): Promise<{ status: 'ready' | 'blocked'; code?: string; admitted?: number }>;
  inspectRun(
    manifest: AgentManifest,
    workspace: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<'pending' | 'completed' | 'failed'>;
  readDispatch?(scope: string): Promise<{ records: OpenClawDispatchRecord[] }>;
  now?(): number;
  sleep?: typeof abortableDelay;
}

function diagnostic(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[a-z][a-z0-9-]{0,127}$/u.test(code)) return code;
  return 'github-notification-native-state-unavailable';
}

function boundedRequest<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('notification-request-aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(request)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

/** cli observations share native ownership; only refresh requests the installed automation. */
export default class OpenClawNotifications {
  constructor(readonly dependencies: Dependencies) {}

  async inspect(
    manifest: AgentManifest,
    workspace: string,
    selector?: GitHubNotificationItemSelector,
  ): Promise<GitHubNotificationStatusResult> {
    const policy = manifest.github?.notifications;
    const warnings = githubNotificationRuntimeDiagnostics(policy, 'openclaw').filter(
      ({ status }) => status === 'warning',
    );
    const base: GitHubNotificationStatusResult = {
      ...(warnings.length ? { warnings } : {}),
      agentId: manifest.agent.id,
      baseline: { status: 'pending' },
      capacity: {
        active: 0,
        queued: 0,
        limit: policy?.schemaVersion === 2 ? policy.maxConcurrentItems : 0,
      },
      code: 'github-notification-status-pending',
      items: [],
      schemaVersion: 2,
      status: 'pending',
    };
    const blocked = (code: string): GitHubNotificationStatusResult => ({
      ...base,
      code,
      diagnosticCode: code,
      status: 'degraded',
    });
    if (policy?.schemaVersion !== 2 || !policy.runtimes.includes('openclaw'))
      return blocked('github-notification-runtime-unsupported');
    const runtimeBlocker = githubNotificationRuntimeBlocker(policy, 'openclaw');
    if (runtimeBlocker) return blocked('github-notification-workflow-unsupported');
    if (!policy.issueAssignment || policy.issueAssignment.enabled === false)
      return blocked('github-notification-disabled');
    if (selector?.itemType === 'pull-request')
      return blocked('github-notification-selector-unsupported');
    try {
      const { selected, store } = await this.dependencies.intake.select(manifest, workspace);
      const state = await store.read();
      if (!selected || !state) return blocked('intake-activation-required');
      const journal = await (this.dependencies.readDispatch?.(store.location.scope) ??
        new OpenClawDispatchStore(this.dependencies.root, store.location.scope).read());
      const capacity = dispatchCapacity(journal.records, selected.policy.maxConcurrentItems);
      const pending = pendingDispatchAssignments(journal, state);
      const latest = new Map<string, IntakeState['records'][number]>();
      for (const record of state.records)
        latest.set(
          `${record.repository.owner.login}/${record.repository.name}#${record.issue.number}`,
          record,
        );
      const items: GitHubNotificationStatusResult['items'] = [...latest.values()].map((item) => {
        const waiting = pending.find((entry) => entry.intake.id === item.id);
        const record = waiting
          ? waiting.record
          : journal.records.findLast((entry) => entry.issueKey === issueKey(item));
        const prepared = Boolean(
          record?.worktree &&
          record.threadId &&
          (record.sessionCreation?.verified ||
            (record.native?.sessionKey === record.threadId &&
              record.effective?.status === 'verified' &&
              record.setupComplete)),
        );
        const feedback = record?.feedback;
        const latestFeedback = feedback?.events.at(-1);
        const feedbackFailure =
          feedback?.code ?? (latestFeedback?.phase === 'blocked' ? latestFeedback.code : undefined);
        const phase = record?.retired
          ? 'retired'
          : (record?.result?.outcome ??
            (record?.phase === 'creating' ? 'uncertain' : (record?.phase ?? 'queued')));
        return {
          itemType: 'issue',
          lifecycleId: 'issue',
          repository: `${item.repository.owner.login}/${item.repository.name}`,
          number: item.issue.number,
          disposition: record?.retired ? 'retired' : 'approved',
          reasonCode:
            feedbackFailure ??
            record?.blocker ??
            (record?.result?.outcome === 'operator-setup-blocker'
              ? record.result.code
              : `github-notification-${phase}`),
          stage: record?.retired ? 'retired' : prepared ? 'prepared' : 'admitted',
          ...(record?.phase === 'complete' || record?.retired
            ? {}
            : {
                scheduling:
                  record && ['blocked', 'waiting', 'retrying'].includes(record.phase)
                    ? ('waiting' as const)
                    : record?.request
                      ? ('active' as const)
                      : ('queued' as const),
              }),
          ...(record?.result?.outcome === 'clarification-needed'
            ? { waitingReason: 'clarification-needed' }
            : {}),
          worktree: record?.worktree ? 'ready' : 'pending',
          ...(feedbackFailure ? { failureCode: feedbackFailure } : {}),
          ...(feedback
            ? {
                feedback: {
                  queued: feedback.events.filter((event) => event.phase === 'queued').length,
                  active: feedback.events.filter(
                    (event) =>
                      event.phase !== 'blocked' && event.turn && event.turn.status !== 'completed',
                  ).length,
                  blocked: feedback.events.filter((event) => event.phase === 'blocked').length,
                },
              }
            : {}),
          ...(record?.blocker
            ? { failureCode: record.blocker }
            : record?.result?.outcome === 'operator-setup-blocker'
              ? { failureCode: record.result.code }
              : {}),
          workflow: { phase, ...(record?.threadId ? { conversation: record.threadId } : {}) },
        };
      });
      const code =
        (await this.dependencies.intake.readiness(manifest, workspace)) ?? state.blocker?.code;
      return {
        ...base,
        baseline: { status: 'ready', observedAt: state.baselineAt },
        scan: { completedAt: state.checkpoint, attemptedAt: state.lastAttemptAt },
        capacity: {
          active: capacity.occupied,
          queued:
            pending.filter(({ record }) => !record?.request).length +
            journal.records.reduce(
              (count, record) =>
                count +
                (record.feedback?.events.filter((event) => event.phase === 'queued').length ?? 0),
              0,
            ),
          limit: selected.policy.maxConcurrentItems,
        },
        items: items.filter(
          (item) =>
            !selector ||
            (item.repository.toLowerCase() === selector.repository.toLowerCase() &&
              item.number === selector.number),
        ),
        status:
          code || warnings.length || items.some((item) => item.failureCode)
            ? 'degraded'
            : state.checkpoint === undefined
              ? 'pending'
              : 'ready',
        code:
          code ??
          (state.checkpoint === undefined
            ? 'github-notification-scan-pending'
            : warnings.length
              ? 'github-notification-capabilities-degraded'
              : 'github-notification-status-ready'),
        ...(code ? { diagnosticCode: code } : {}),
      };
    } catch (error) {
      return blocked(diagnostic(error));
    }
  }

  async refresh(
    manifest: AgentManifest,
    workspace: string,
    options: { selector?: GitHubNotificationItemSelector; signal: AbortSignal },
  ): Promise<NotificationRefreshResult> {
    const fail = (code: string): NotificationRefreshResult => ({
      agentId: manifest.agent.id,
      code,
      diagnosticCode: code,
      status: 'failed',
    });
    if (options.selector?.itemType === 'pull-request')
      return fail('github-notification-refresh-selector-unsupported');
    const observation = await this.inspect(manifest, workspace);
    if (observation.diagnosticCode) return fail(observation.diagnosticCode);
    if (options.signal.aborted) return fail('github-notification-refresh-cancelled');
    try {
      if (options.selector) {
        const scan = await boundedRequest(options.signal, () =>
          this.dependencies.scanSelected(manifest, workspace, options.selector!, options.signal),
        );
        if (scan.status !== 'ready') return fail(scan.code ?? 'github-notification-intake-failed');
        return {
          agentId: manifest.agent.id,
          status: 'completed',
          code: 'github-notification-intake-completed',
          admitted: scan.admitted,
          baselineAt: observation.baseline.observedAt,
        };
      }
      const result = await boundedRequest(options.signal, () =>
        this.dependencies.requestRun(manifest, workspace, options.signal),
      );
      return {
        agentId: manifest.agent.id,
        status: result.status,
        code:
          result.status === 'queued'
            ? 'github-notification-refresh-queued'
            : `github-notification-refresh-${result.reason ?? 'skipped'}`,
        ...(result.runId ? { runId: result.runId } : {}),
        ...(observation.baseline.observedAt === undefined
          ? {}
          : { baselineAt: observation.baseline.observedAt }),
      };
    } catch (error) {
      return fail(
        options.signal.aborted
          ? 'github-notification-refresh-outcome-uncertain'
          : diagnostic(error),
      );
    }
  }

  async wait(
    manifest: AgentManifest,
    workspace: string,
    input: {
      selector?: GitHubNotificationItemSelector;
      target: GitHubNotificationWaitTarget;
      timeoutMs: number;
      refresh: boolean;
    },
  ): Promise<GitHubNotificationWaitResult> {
    const now = this.dependencies.now ?? Date.now;
    const deadline = now() + input.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.timeoutMs);
    let requested = false;
    let runId: string | undefined;
    try {
      while (true) {
        const observation = await this.inspect(manifest, workspace, input.selector);
        const result = (
          status: GitHubNotificationWaitResult['status'],
          code: string,
        ): GitHubNotificationWaitResult => ({
          agentId: manifest.agent.id,
          schemaVersion: 2,
          status,
          code,
          target: input.target,
          observation,
        });
        if (input.target === 'assignment-rejected' || input.target === 'retired')
          return result('failed', 'github-notification-wait-target-unsupported');
        const reached = evaluateGitHubNotificationWait(observation, input.target, input.selector);
        if (observation.diagnosticCode) return result('failed', observation.diagnosticCode);
        if (reached.status === 'reached') return result('completed', reached.code);
        if (reached.status === 'failed') return result('failed', reached.code);
        if (controller.signal.aborted || now() >= deadline)
          return result('timed-out', 'github-notification-wait-timeout');
        if (input.refresh && runId) {
          try {
            const execution = await boundedRequest(controller.signal, () =>
              this.dependencies.inspectRun(manifest, workspace, runId!, controller.signal),
            );
            if (execution === 'failed')
              return result('failed', 'github-notification-refresh-run-failed');
            if (execution === 'completed') {
              requested = false;
              runId = undefined;
              continue;
            }
          } catch (error) {
            return result(
              controller.signal.aborted ? 'timed-out' : 'failed',
              controller.signal.aborted ? 'github-notification-wait-timeout' : diagnostic(error),
            );
          }
        }
        if (input.refresh && !requested) {
          const refreshed = await this.refresh(manifest, workspace, {
            signal: controller.signal,
            selector: input.selector,
          });
          if (
            refreshed.status !== 'queued' &&
            refreshed.status !== 'completed' &&
            refreshed.code !== 'github-notification-refresh-already-running'
          )
            return result('failed', refreshed.code);
          runId = refreshed.runId;
          requested =
            refreshed.status === 'queued' ||
            (refreshed.status === 'completed' &&
              ((refreshed.admitted ?? 0) > 0 || observation.items.length > 0));
        }
        try {
          await (this.dependencies.sleep ?? abortableDelay)(
            Math.min(1000, Math.max(0, deadline - now())),
            controller.signal,
          );
        } catch {
          return result('timed-out', 'github-notification-wait-timeout');
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
