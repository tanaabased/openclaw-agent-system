import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';
import type assignmentIntakePolicy from './assignment-intake-policy.ts';
import assignmentRetirement, {
  awaitingReassignment,
  type Retirement,
} from './tasks/retirement/assignment-retirement.ts';
import {
  cleanupConfigurationDiagnostic,
  type CleanupConfiguration,
} from './cleanup-configuration.ts';
import type DiscoveryBudget from './discovery-budget.ts';
import { inspectAdmittedIssue, inspectAssignmentRemoval } from './dispatch-assignment.ts';
import { issueKey } from './dispatch-pending.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import {
  dispatchAdmission,
  managedPullRequest,
  type ManagedIssue as IntakeRecord,
} from './managed-issue.ts';
import workflowFailure from './workflow-failure.ts';
export interface RetirementNativeObservation {
  archived: boolean;
  idle: boolean;
  activityId?: string;
  unavailableSession?: NonNullable<Retirement['sessionUnavailableObserved']>['session'];
}
export interface RetirementCleanupResult {
  archived: boolean;
  worktreeRemoved: boolean;
  unavailableSession?: NonNullable<Retirement['sessionUnavailableObserved']>['session'];
  code?: string;
}
/** one bounded pass owns membership; native adapters own preservation and resource effects. */
export default async function reconcileAssignmentLifecycle<R extends SharedDispatchRecord>(input: {
  records: R[];
  admitted: IntakeRecord[];
  policy: NonNullable<ReturnType<typeof assignmentIntakePolicy>>;
  client: GitHubNotificationIntakeClient;
  targetId?: string;
  budget?: DiscoveryBudget;
  now: number;
  configuration: CleanupConfiguration;
  readConfiguration(): Promise<CleanupConfiguration>;
  observe(record: R): Promise<RetirementNativeObservation | undefined>;
  cleanup(
    record: R,
    intake: IntakeRecord,
    fresh: () => Promise<void>,
    shared: readonly R[],
    native: RetirementNativeObservation | undefined,
    issueClosed: boolean,
  ): Promise<RetirementCleanupResult>;
  reactivate?(record: R, intake: IntakeRecord): Promise<boolean>;
  prepare?(record: R, intake: IntakeRecord): Promise<void>;
  dispose(record: R, intake: IntakeRecord): Promise<void>;
  fresh(): Promise<void>;
  save(): Promise<void>;
}) {
  const { now, client, policy } = input;
  const read = <T>(operation: string, run: () => Promise<T>) =>
    input.budget ? input.budget.read(operation, run) : run();
  const configuration = input.configuration;
  const graceMinutes = configuration.status === 'ready' ? configuration.graceMinutes : undefined;
  const latest = new Map(input.admitted.map((item) => [issueKey(item), item]));
  const selected = input.records
    .filter((record) => !record.supersededBy && !record.reset)
    .filter((record) => !input.targetId || record.id === input.targetId)
    .filter(
      (record) =>
        input.targetId === record.id ||
        (record.lifecycleCheckedAt ?? -Infinity) + 60000 <= now ||
        record.retirement?.code === 'retirement-native-inventory-required' ||
        record.retirement?.archiveAttempt,
    )
    .sort(
      (a, b) =>
        (a.lifecycleCheckedAt ?? 0) - (b.lifecycleCheckedAt ?? 0) ||
        Number(Boolean(b.lifecyclePending)) - Number(Boolean(a.lifecyclePending)),
    )
    .slice(0, 12);
  for (const record of selected) {
    if (input.budget?.exhausted) break;
    record.lifecycleCheckedAt = now;
    delete record.lifecyclePending;
    const admitted = dispatchAdmission(record, input.admitted);
    if (!admitted) continue;
    try {
      const wasMissing = Boolean(record.assignmentObservation);
      const provider = async (admission = admitted, target: R = record) => {
        input.budget?.check();
        if (
          !githubIdentityMatches(client.identity, admission.receiving) ||
          client.identity.login.toLowerCase() !== policy.username.toLowerCase()
        )
          throw new Error('dispatch-receiver-account-changed');
        const repo = await read('lifecycle-repository', () =>
          client.getRepository(admission.repository.owner.login, admission.repository.name),
        );
        input.budget?.check();
        if (
          repo.nodeId !== admission.repository.nodeId ||
          repo.databaseId !== admission.repository.databaseId
        )
          throw new Error('dispatch-repository-identity-changed');
        const item = await read('lifecycle-issue', () =>
          client.getItem(
            admission.repository.owner.login,
            admission.repository.name,
            admission.issue.number,
          ),
        );
        input.budget?.check();
        if (
          item.nodeId !== admission.issue.nodeId ||
          item.databaseId !== admission.issue.databaseId ||
          item.number !== admission.issue.number ||
          item.itemType !== (managedPullRequest(admission) ? 'pull-request' : 'issue')
        )
          throw new Error('dispatch-issue-identity-changed');
        if (item.state !== 'open') {
          delete target.assignmentObservation;
          return 'issue-closed' as const;
        }
        const observation = await read('lifecycle-assignment', () =>
          inspectAssignmentRemoval(
            admission,
            client,
            item,
            policy.policy.issueAssignment?.allowed ?? [],
            now,
          ),
        );
        input.budget?.check();
        if (observation) target.assignmentObservation = observation;
        else delete target.assignmentObservation;
        return observation?.code === 'assignment-removal-approved'
          ? ('assignment-removed' as const)
          : undefined;
      };
      const reason = await provider();
      // reopening within grace cancels cleanup without inventing another assignment event.
      if (
        reason !== 'issue-closed' &&
        record.retirement?.reason === 'issue-closed' &&
        !record.cleanupPending &&
        !record.retirement.operatorRequest &&
        !record.retirement.archiveAttempt &&
        !record.retirement.archiveRequest &&
        !record.retirement.archivedAt &&
        !record.retirement.worktreeRemovalAttemptedAt &&
        !record.retirement.worktreeRemovedAt
      )
        delete record.retirement;
      const removal = record.retirement?.reason === 'assignment-removed';
      if (
        removal &&
        record.assignmentObservation &&
        reason !== 'assignment-removed' &&
        reason !== 'issue-closed'
      ) {
        // uncertain or completed native effects retain their receipts, never become a retry grant.
        if (
          record.retirement!.archiveAttempt ||
          record.retirement!.archiveRequest ||
          record.retirement!.archivedAt ||
          record.retirement!.worktreeRemovalAttemptedAt ||
          record.retirement!.worktreeRemovedAt
        ) {
          record.retirement!.code = 'retirement-removal-authority-unresolved';
          continue;
        }
        delete record.retirement;
      }
      if (
        reason === 'assignment-removed' &&
        removal &&
        record.retirement!.removalEventId !== record.assignmentObservation?.event?.nodeId
      ) {
        if (graceMinutes === undefined) record.retirement!.deadlinePending = true;
        else record.retirement!.eligibleAt = now + graceMinutes * 60000;
      }
      // provider closure or approved removal can stop scheduling without a native observation.
      if (reason)
        record.retirement = assignmentRetirement({
          previous: record.retirement,
          reason,
          intakeId: latest.get(record.issueKey)?.id ?? record.intakeId ?? record.manualIssue!.id,
          now,
          graceMinutes,
        });
      if (reason === 'assignment-removed')
        record.retirement!.removalEventId = record.assignmentObservation!.event!.nodeId;
      let native: RetirementNativeObservation | undefined;
      try {
        native = await read('lifecycle-session', () => input.observe(record));
      } catch (error) {
        input.budget?.check();
        if (record.retirement)
          record.retirement.code = workflowFailure(
            error,
            'retirement-native-observation-unavailable',
          ).code;
        continue;
      }
      input.budget?.check();
      if (
        record.retirement &&
        reason !== 'issue-closed' &&
        !record.retirement.operatorRequest &&
        record.nativeInactive === false &&
        native?.idle
      ) {
        if (graceMinutes === undefined) record.retirement.deadlinePending = true;
        else record.retirement.eligibleAt = now + graceMinutes * 60000;
      }
      // an unavailable session supersedes an earlier activity observation, not proof of idleness.
      if (native?.unavailableSession) delete record.nativeInactive;
      else if (native && (record.retirement || native.archived))
        record.nativeInactive = native.idle;
      if (reason === 'issue-closed' || native?.archived) delete record.feedbackReactivation;
      const successor = latest.get(record.issueKey);
      if (
        !reason &&
        !record.retirement?.operatorRequest &&
        !record.cleanupPending &&
        (record.retirement || record.feedbackReactivation || wasMissing) &&
        !record.assignmentObservation &&
        native &&
        !native.unavailableSession &&
        !native.archived &&
        !record.retirement?.archivedAt &&
        !record.retirement?.archiveAttempt &&
        !record.retirement?.archiveRequest &&
        !record.retirement?.worktreeRemovalAttemptedAt &&
        !record.retirement?.worktreeRemovedAt &&
        record.retirement?.reason !== 'chat-archived' &&
        successor &&
        (!record.retirement?.operatorRequest ||
          (successor.assignment
            ? Date.parse(successor.assignment.createdAt)
            : successor.admittedAt) > record.retirement.operatorRequest.at) &&
        successor.id !== (record.retirement?.intakeId ?? record.intakeId)
      ) {
        await inspectAdmittedIssue(successor, client);
        await input.fresh();
        record.intakeId = successor.id;
        delete record.retirement;
        delete record.feedbackReactivation;
        await input.save();
        continue;
      }
      const reactivate = async () => {
        if (
          !record.retirement?.operatorRequest &&
          !record.cleanupPending &&
          native &&
          !native.unavailableSession &&
          !native.archived &&
          reason !== 'issue-closed' &&
          record.retirement?.reason !== 'chat-archived' &&
          !record.retirement?.archivedAt &&
          !record.retirement?.archiveAttempt &&
          !record.retirement?.archiveRequest &&
          !record.retirement?.worktreeRemovalAttemptedAt &&
          !record.retirement?.worktreeRemovedAt &&
          (record.retirement || record.feedbackReactivation) &&
          input.reactivate &&
          (await input.reactivate(record, admitted))
        ) {
          await input.fresh();
          const verifiedNative = await input.observe(record);
          if (
            !verifiedNative ||
            verifiedNative.unavailableSession ||
            verifiedNative.archived ||
            (await provider()) === 'issue-closed'
          )
            throw new Error('retirement-observation-changed');
          delete record.retirement;
          return true;
        }
        return false;
      };
      if (await reactivate()) continue;
      // open removal is dormant membership, including old pending effects; only closure resumes cleanup.
      if (awaitingReassignment(record)) continue;
      record.retirement = assignmentRetirement({
        previous: record.retirement,
        reason:
          reason !== 'issue-closed' &&
          native?.archived &&
          record.retirement?.reason !== 'assignment-removed'
            ? 'chat-archived'
            : reason,
        intakeId: successor?.id ?? record.intakeId ?? record.manualIssue!.id,
        now,
        graceMinutes,
        activityId: reason === 'issue-closed' ? undefined : native?.activityId,
      });
      if (!record.retirement) continue;
      if (native?.unavailableSession)
        record.retirement.sessionUnavailableObserved = {
          at: now,
          session: native.unavailableSession,
        };
      delete record.retirement.code;
      // reopening cancels closure-driven reclamation, but is not itself a fresh assignment.
      if (
        !record.retirement.operatorRequest &&
        !reason &&
        !native?.archived &&
        record.retirement.reason === 'issue-closed'
      ) {
        record.retirement.code = 'retirement-awaiting-reactivation';
        continue;
      }
      if (
        !record.retirement.operatorRequest &&
        !reason &&
        record.retirement.reason === 'assignment-removed'
      ) {
        record.retirement.code = 'retirement-awaiting-reactivation';
        continue;
      }
      if (configuration.status === 'blocked' && !record.retirement.operatorRequest) {
        record.retirement.code = configuration.code;
        record.retirement.diagnostic = cleanupConfigurationDiagnostic(configuration);
        continue;
      }
      delete record.retirement.diagnostic;
      if (native?.unavailableSession && native.unavailableSession !== 'not-found') {
        record.retirement.code = 'retirement-native-' + native.unavailableSession;
        continue;
      }
      if (now < record.retirement.eligibleAt) continue;
      await input.prepare?.(record, admitted);
      if (record.request && !native?.idle && !native?.unavailableSession) {
        record.retirement.code = 'retirement-native-work-unresolved';
        continue;
      }
      const shared = input.records.filter(
        (other) => other.id !== record.id && record.worktree && other.worktree === record.worktree,
      );
      if (shared.length) throw new Error('retirement-worktree-shared');
      const fresh = async () => {
        await input.fresh();
        const current = await input.readConfiguration();
        if (current.status === 'blocked' && !record.retirement!.operatorRequest) {
          record.retirement!.diagnostic = cleanupConfigurationDiagnostic(current);
          throw new Error(current.code);
        }
        if (
          !record.retirement!.operatorRequest &&
          current.status === 'ready' &&
          configuration.status === 'ready' &&
          current.digest !== configuration.digest
        )
          throw new Error('retirement-configuration-changed');
        if (await reactivate()) throw new Error('retirement-reactivated');
        const eventId = record.retirement?.removalEventId;
        const currentReason = await provider();
        const currentNative = await input.observe(record);
        if (
          (reason === 'issue-closed' && currentReason !== 'issue-closed') ||
          (record.retirement?.reason === 'assignment-removed' &&
            (currentReason !== 'assignment-removed' ||
              eventId !== record.assignmentObservation?.event?.nodeId)) ||
          (!currentReason && !currentNative?.archived && !record.retirement?.operatorRequest) ||
          (record.request && !currentNative?.idle && !currentNative?.unavailableSession) ||
          currentNative?.unavailableSession !== native?.unavailableSession ||
          (currentReason !== 'issue-closed' && currentNative?.activityId !== native?.activityId)
        )
          throw new Error('retirement-observation-changed');
      };
      await fresh();
      const result = await input.cleanup(
        record,
        admitted,
        fresh,
        shared,
        native,
        reason === 'issue-closed',
      );
      if (result.archived) record.retirement.archivedAt ??= now;
      if (result.worktreeRemoved) record.retirement.worktreeRemovedAt ??= now;
      if (result.code) record.retirement.code = result.code;
      if (
        (result.archived || result.unavailableSession === 'not-found') &&
        result.worktreeRemoved &&
        !result.code
      ) {
        await input.dispose(record, admitted);
      }
    } catch (error) {
      if (input.budget?.exhausted) {
        record.lifecyclePending = true;
        break;
      }
      if (record.retirement)
        record.retirement.code = workflowFailure(error, 'retirement-check-unavailable').code;
    } finally {
      await input.save();
    }
  }
}
