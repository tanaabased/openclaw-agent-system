import assignmentRetirement from './assignment-retirement.ts';
import revalidateAssignment from './dispatch-assignment.ts';
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
}
export interface RetirementCleanupResult {
  archived: boolean;
  worktreeRemoved: boolean;
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
  observe(record: R): Promise<RetirementNativeObservation | undefined>;
  cleanup(
    record: R,
    intake: IntakeRecord,
    fresh: () => Promise<void>,
  ): Promise<RetirementCleanupResult>;
  reactivate?(record: R, intake: IntakeRecord): Promise<boolean>;
  fresh(): Promise<void>;
  save(): Promise<void>;
}) {
  const { now, client, policy } = input;
  const configuration = policy.policy.cleanup ?? { enabled: true, graceMinutes: 60 };
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
      const provider = async () => {
        if (
          !githubIdentityMatches(client.identity, admitted.receiving) ||
          client.identity.login.toLowerCase() !== policy.username.toLowerCase()
        )
          throw new Error('dispatch-receiver-account-changed');
        const item = await client.getItem(
          admitted.repository.owner.login,
          admitted.repository.name,
          admitted.issue.number,
        );
        if (
          item.nodeId !== admitted.issue.nodeId ||
          item.databaseId !== admitted.issue.databaseId ||
          item.itemType !== 'issue'
        )
          throw new Error('dispatch-issue-identity-changed');
        return item.state !== 'open'
          ? ('issue-closed' as const)
          : !item.assignees.some((identity) => githubIdentityMatches(identity, client.identity))
            ? ('assignment-removed' as const)
            : undefined;
      };
      const reason = await provider();
      // provider closure/removal can retire membership even if the native host is unavailable.
      if (reason)
        record.retirement = assignmentRetirement({
          previous: record.retirement,
          reason,
          intakeId: latest.get(record.issueKey)?.id ?? record.intakeId,
          now,
          graceMinutes: configuration.graceMinutes,
        });
      let native: RetirementNativeObservation | undefined;
      try {
        native = await input.observe(record);
      } catch (error) {
        if (record.retirement)
          record.retirement.code = workflowFailure(
            error,
            'retirement-native-observation-unavailable',
          ).code;
        await input.save();
        continue;
      }
      if (record.retirement && record.nativeInactive === false && native?.idle)
        record.retirement.eligibleAt = now + configuration.graceMinutes * 60_000;
      if (native && (record.retirement || native.archived)) record.nativeInactive = native.idle;
      if (reason === 'issue-closed' || native?.archived) delete record.feedbackReactivation;
      const successor = latest.get(record.issueKey);
      if (
        !reason &&
        (record.retirement || record.feedbackReactivation) &&
        native &&
        !native.archived &&
        !record.retirement?.archivedAt &&
        !record.retirement?.archiveAttempt &&
        record.retirement?.reason !== 'chat-archived' &&
        successor &&
        successor.id !== (record.retirement?.intakeId ?? record.intakeId)
      ) {
        await revalidateAssignment(policy, successor, client);
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
          if (!verifiedNative || verifiedNative.archived || (await provider()) === 'issue-closed')
            throw new Error('retirement-observation-changed');
          delete record.retirement;
          return true;
        }
        return false;
      };
      if (await reactivate()) continue;
      record.retirement = assignmentRetirement({
        previous: record.retirement,
        reason: native?.archived ? 'chat-archived' : reason,
        intakeId: successor?.id ?? record.intakeId,
        now,
        graceMinutes: configuration.graceMinutes,
        activityId: native?.activityId,
      });
      if (!record.retirement) continue;
      delete record.retirement.code;
      // reopening cancels closure-driven reclamation, but is not itself a fresh assignment.
      if (!reason && !native?.archived && record.retirement.reason === 'issue-closed') {
        record.retirement.code = 'retirement-awaiting-reactivation';
        continue;
      }
      if (configuration.enabled && now < record.retirement.eligibleAt) continue;
      if (record.request && !native?.idle) {
        record.retirement.code = 'retirement-native-work-unresolved';
        continue;
      }
      if (!configuration.enabled) {
        record.retired = { at: now, by: input.owner };
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
        if (shared.some((other) => !other.retired)) throw new Error('retirement-worktree-shared');
        await input.fresh();
        if (await reactivate()) throw new Error('retirement-reactivated');
        const currentReason = await provider();
        const currentNative = await input.observe(record);
        if (
          (!currentReason && !currentNative?.archived) ||
          (record.request && !currentNative?.idle) ||
          currentNative?.activityId !== native?.activityId
        )
          throw new Error('retirement-observation-changed');
      };
      await fresh();
      const result = await input.cleanup(record, admitted, fresh);
      if (result.archived) record.retirement.archivedAt ??= now;
      if (result.worktreeRemoved) record.retirement.worktreeRemovedAt ??= now;
      if (result.code) record.retirement.code = result.code;
      if (result.archived && result.worktreeRemoved) record.retired = { at: now, by: input.owner };
    } catch (error) {
      if (record.retirement)
        record.retirement.code = workflowFailure(error, 'retirement-check-unavailable').code;
    } finally {
      await input.save();
    }
  }
}
