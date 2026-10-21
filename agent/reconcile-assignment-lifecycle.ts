import {
  cleanupConfigurationDiagnostic,
  type CleanupConfiguration,
} from './cleanup-configuration.ts';
import assignmentRetirement, {
  unverifiedLegacyRetirement,
  type Retirement,
} from './assignment-retirement.ts';
import { inspectAdmittedIssue, inspectAssignmentRemoval } from './dispatch-assignment.ts';
import { issueKey } from './dispatch-pending.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type assignmentIntakePolicy from './assignment-intake-policy.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';
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
  owner: string;
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
  ): Promise<RetirementCleanupResult>;
  reactivate?(record: R, intake: IntakeRecord): Promise<boolean>;
  fresh(): Promise<void>;
  save(): Promise<void>;
}) {
  const { now, client, policy } = input;
  const configuration = input.configuration;
  const graceMinutes = configuration.status === 'ready' ? configuration.graceMinutes : undefined;
  const latest = new Map(input.admitted.map((item) => [issueKey(item), item]));
  const selected = input.records
    .filter((record) => !record.reset && !record.retired && record.sourceThreadId === input.owner)
    .filter(
      (record) =>
        (record.lifecycleCheckedAt ?? -Infinity) + 60_000 <= now ||
        record.retirement?.code === 'retirement-native-inventory-required' ||
        record.retirement?.archiveAttempt,
    )
    .sort((a, b) => (a.lifecycleCheckedAt ?? 0) - (b.lifecycleCheckedAt ?? 0))
    .slice(0, 12);
  for (const record of selected) {
    record.lifecycleCheckedAt = now;
    const admitted = input.admitted.find((item) => item.id === record.intakeId);
    if (!admitted) continue;
    try {
      const wasMissing = Boolean(record.assignmentObservation);
      const provider = async (admission = admitted, target: R = record) => {
        if (
          !githubIdentityMatches(client.identity, admission.receiving) ||
          client.identity.login.toLowerCase() !== policy.username.toLowerCase()
        )
          throw new Error('dispatch-receiver-account-changed');
        const repo = await client.getRepository(
          admission.repository.owner.login,
          admission.repository.name,
        );
        if (
          repo.nodeId !== admission.repository.nodeId ||
          repo.databaseId !== admission.repository.databaseId
        )
          throw new Error('dispatch-repository-identity-changed');
        const item = await client.getItem(
          admission.repository.owner.login,
          admission.repository.name,
          admission.issue.number,
        );
        if (
          item.nodeId !== admission.issue.nodeId ||
          item.databaseId !== admission.issue.databaseId ||
          item.number !== admission.issue.number ||
          item.itemType !== 'issue'
        )
          throw new Error('dispatch-issue-identity-changed');
        if (item.state !== 'open') {
          delete target.assignmentObservation;
          return 'issue-closed' as const;
        }
        const observation = await inspectAssignmentRemoval(
          admission,
          client,
          item,
          policy.policy.issueAssignment?.allowed ?? [],
          now,
        );
        if (observation) target.assignmentObservation = observation;
        else delete target.assignmentObservation;
        return observation?.code === 'assignment-removal-approved'
          ? ('assignment-removed' as const)
          : undefined;
      };
      const reason = await provider();
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
        else record.retirement!.eligibleAt = now + graceMinutes * 60_000;
      }
      // provider closure or approved removal can stop scheduling without a native observation.
      if (reason)
        record.retirement = assignmentRetirement({
          previous: record.retirement,
          reason,
          intakeId: latest.get(record.issueKey)?.id ?? record.intakeId,
          now,
          graceMinutes,
        });
      if (reason === 'assignment-removed')
        record.retirement!.removalEventId = record.assignmentObservation!.event!.nodeId;
      let native: RetirementNativeObservation | undefined;
      try {
        native = await input.observe(record);
      } catch (error) {
        if (record.retirement)
          record.retirement.code = workflowFailure(
            error,
            'retirement-native-observation-unavailable',
          ).code;
        continue;
      }
      if (record.retirement && record.nativeInactive === false && native?.idle) {
        if (graceMinutes === undefined) record.retirement.deadlinePending = true;
        else record.retirement.eligibleAt = now + graceMinutes * 60_000;
      }
      if (native && !native.unavailableSession && (record.retirement || native.archived))
        record.nativeInactive = native.idle;
      if (reason === 'issue-closed' || native?.archived) delete record.feedbackReactivation;
      const successor = latest.get(record.issueKey);
      if (
        !reason &&
        (record.retirement || record.feedbackReactivation || wasMissing) &&
        !record.assignmentObservation &&
        native &&
        !native.unavailableSession &&
        !native.archived &&
        !record.retirement?.archivedAt &&
        !record.retirement?.archiveAttempt &&
        record.retirement?.reason !== 'chat-archived' &&
        successor &&
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
          native &&
          !native.unavailableSession &&
          !native.archived &&
          reason !== 'issue-closed' &&
          record.retirement?.reason !== 'chat-archived' &&
          !record.retirement?.archivedAt &&
          !record.retirement?.archiveAttempt &&
          !record.retirement?.worktreeRemovalAttemptedAt &&
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
      record.retirement = assignmentRetirement({
        previous: record.retirement,
        reason:
          native?.archived && record.retirement?.reason !== 'assignment-removed'
            ? 'chat-archived'
            : reason,
        intakeId: successor?.id ?? record.intakeId,
        now,
        graceMinutes,
        activityId: native?.activityId,
      });
      if (!record.retirement) continue;
      if (native?.unavailableSession)
        record.retirement.sessionUnavailableObserved = {
          at: now,
          session: native.unavailableSession,
        };
      delete record.retirement.code;
      // reopening cancels closure-driven reclamation, but is not itself a fresh assignment.
      if (!reason && !native?.archived && record.retirement.reason === 'issue-closed') {
        record.retirement.code = 'retirement-awaiting-reactivation';
        continue;
      }
      if (!reason && record.retirement.reason === 'assignment-removed') {
        record.retirement.code = 'retirement-awaiting-reactivation';
        continue;
      }
      if (configuration.status === 'blocked') {
        record.retirement.code = configuration.code;
        record.retirement.diagnostic = cleanupConfigurationDiagnostic(configuration);
        continue;
      }
      delete record.retirement.diagnostic;
      if (now < record.retirement.eligibleAt) continue;
      if (record.request && !native?.idle && !native?.unavailableSession) {
        record.retirement.code = 'retirement-native-work-unresolved';
        continue;
      }
      const shared = input.records.filter(
        (other) => other.id !== record.id && record.worktree && other.worktree === record.worktree,
      );
      const reclaimed = shared.find(
        (other) =>
          other.retirement?.worktreeRemovedAt &&
          other.retirement.worktreeRemovedAt >= record.createdAt,
      );
      if (reclaimed?.retirement?.worktreeRemovedAt)
        record.retirement.worktreeRemovedAt = reclaimed.retirement.worktreeRemovedAt;
      const fresh = async () => {
        await input.fresh();
        const current = await input.readConfiguration();
        if (current.status === 'blocked') {
          record.retirement!.diagnostic = cleanupConfigurationDiagnostic(current);
          throw new Error(current.code);
        }
        if (current.digest !== configuration.digest)
          throw new Error('retirement-configuration-changed');
        // pending owners can archive independently; active or unknown owners still fence reclamation.
        if (shared.length > 12) throw new Error('retirement-worktree-shared');
        for (const other of shared) {
          if (other.retired) {
            if (unverifiedLegacyRetirement(other)) throw new Error('retirement-worktree-shared');
            continue;
          }
          const otherIntake = input.admitted.find((item) => item.id === other.intakeId);
          if (
            other.sourceThreadId !== input.owner ||
            other.reset ||
            !otherIntake ||
            !other.retirement ||
            other.retirement.deadlinePending ||
            now < other.retirement.eligibleAt
          )
            throw new Error('retirement-worktree-shared');
          const otherNative = await input.observe(other);
          const otherReason = await provider(otherIntake, other);
          if (
            !otherNative ||
            (!otherNative.idle && !otherNative.unavailableSession) ||
            (other.retirement.reason === 'assignment-removed' &&
              otherReason !== 'assignment-removed') ||
            (!otherNative.unavailableSession &&
              otherNative.activityId !== other.retirement.activityId) ||
            (!otherReason && !otherNative.archived) ||
            (!otherNative.archived &&
              !otherNative.unavailableSession &&
              otherReason !== 'issue-closed' &&
              input.reactivate &&
              (await input.reactivate(other, otherIntake)))
          )
            throw new Error('retirement-worktree-shared');
        }
        if (await reactivate()) throw new Error('retirement-reactivated');
        const eventId = record.retirement?.removalEventId;
        const currentReason = await provider();
        const currentNative = await input.observe(record);
        if (
          (record.retirement?.reason === 'assignment-removed' &&
            (currentReason !== 'assignment-removed' ||
              eventId !== record.assignmentObservation?.event?.nodeId)) ||
          (!currentReason && !currentNative?.archived) ||
          (record.request && !currentNative?.idle && !currentNative?.unavailableSession) ||
          currentNative?.unavailableSession !== native?.unavailableSession ||
          currentNative?.activityId !== native?.activityId
        )
          throw new Error('retirement-observation-changed');
      };
      await fresh();
      const result = await input.cleanup(
        record,
        admitted,
        fresh,
        shared.filter((other) => !other.retired),
        native,
      );
      if (result.archived) record.retirement.archivedAt ??= now;
      if (result.worktreeRemoved) record.retirement.worktreeRemovedAt ??= now;
      if (result.code) record.retirement.code = result.code;
      if ((result.archived || result.unavailableSession) && result.worktreeRemoved)
        record.retired = { at: now, by: input.owner };
    } catch (error) {
      if (record.retirement)
        record.retirement.code = workflowFailure(error, 'retirement-check-unavailable').code;
    } finally {
      await input.save();
    }
  }
}
