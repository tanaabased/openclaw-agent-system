import recoverIssueTask from './issue-task-recovery.ts';
import openClawEntryContext from './openclaw-entry-context.ts';
import { observeRetiringSession } from './openclaw-retirement-observation.ts';
import IssueDeliveryProvider from '../channels/github/publication/issue-delivery.ts';
import type OpenClawDispatchContext from './openclaw-dispatch-context.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { automationHash } from './automation-hash.ts';
import type { DispatchCaller } from './openclaw-session-create.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';

/** native input and session observation adapt the shared recovery, never create a second lifecycle. */
export default async function recoverOpenClawTask(options: {
  service: OpenClawDispatchContext;
  manifest: AgentManifest;
  workspace: string;
  caller: DispatchCaller;
  input: { id: string; pullRequest: string; digest?: string };
  operator: boolean;
  authority: DispatchAuthority;
}) {
  const { service, manifest, workspace, caller, input, operator, authority } = options;
  return openClawEntryContext(
    {
      manifest,
      workspace,
      caller,
      action: input,
      operator,
      authority,
      dependencies: service.dependencies,
    },
    async (entry) => {
      const current = await service.scope(manifest, workspace);
      return current.journal.exclusive(async (state, save) => {
        const record = state.records.find((record) => record.id === input.id);
        if (!record) throw new Error('dispatch-recovery-owner-missing');
        if (
          !record.manualIssue &&
          caller.sessionKey === (await service.dependencies.coordinator(manifest, workspace))
        )
          throw new Error('dispatch-operator-caller-required');
        const selected = record.supersededBy
          ? state.records.find((r) => r.id === record.supersededBy)
          : record;
        if (!selected) throw new Error('dispatch-recovery-owner-missing');
        const verified = await service.validate(manifest, workspace, selected, true);
        const { intake } = verified;
        const delivery = record.work?.delivery;
        const turns = [
          record.firstTurn,
          record.assessmentTurn,
          record.decisionTurn,
          record.summaryRecovery?.turn,
          record.work?.turn,
          record.work?.deliveryTurn,
        ];
        return recoverIssueTask<OpenClawDispatchRecord>({
          record,
          state,
          intake,
          caller: caller.sessionKey,
          operator: { turnId: entry.turnId, inputId: entry.inputId },
          operatorInput: async () => {
            await entry.assertCurrent();
            return { turnId: entry.turnId, inputId: entry.inputId };
          },
          manifestDigest: automationHash(manifest),
          now: entry.now,
          issueUrl: `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/issues/${intake.issue.number}`,
          digest: input.digest,
          save,
          fresh: entry.assertCurrent,
          ...(!('initiation' in intake) && service.dependencies.claims
            ? {
                claim: (operation: 'preview' | 'reserve') =>
                  service.dependencies.claims!.recover(
                    intake,
                    verified.client,
                    record,
                    automationHash([record.id, 'recovery']),
                    operation,
                  ),
              }
            : {}),
          create: (record) => ({
            ...record,
            manualIssue: record.manualIssue && {
              ...record.manualIssue,
              initiation: { ...record.manualIssue.initiation, incarnation: caller.sessionId },
            },
          }),
          revalidate: () => service.validate(manifest, workspace, record, true),
          effects: {
            pendingNativeTurn: turns.some(
              (turn) =>
                turn && (turn.status !== 'completed' || Boolean(turn.failed || turn.cancelled)),
            ),
            pendingPush: Boolean(delivery?.pendingPush),
            uncertainPrCreation: Boolean(delivery?.creationAttempted && !delivery.pullRequest),
            uncertainAnnouncement: Boolean(
              delivery?.announcement?.attempted && !delivery.announcement.receipt,
            ),
            pendingFeedback: record.feedback?.events.some(
              (event) => !['complete', 'cancelled', 'held'].includes(event.phase),
            ),
            assignmentClaim: Boolean(
              (record.claimId || record.claimAccepted) &&
              (!service.dependencies.claims || 'initiation' in intake),
            ),
          },
          observe: () =>
            service.dependencies.credential.use(authority, async (request) => {
              const native = await observeRetiringSession(request, record, manifest.agent.id);
              if (!native?.idle || native.archived || !native.activityId)
                throw new Error('dispatch-recovery-chat-active-or-unverified');
              return native;
            }),
          adopt: async () => {
            const connection = await entry.connectDelivery!(workspace);
            if (connection.account.identity.nodeId !== intake.receiving.nodeId)
              throw new Error('delivery-adoption-account-changed');
            const adopted = await new IssueDeliveryProvider(connection.account).adopt(
              {
                repositoryNodeId: intake.repository.nodeId,
                item: {
                  number: intake.issue.number,
                  itemNodeId: intake.issue.nodeId,
                  itemDatabaseId: intake.issue.databaseId,
                  repositoryOwner: intake.repository.owner.login,
                  repositoryName: intake.repository.name,
                  repositoryDefaultBranch: verified.repo.defaultBranch,
                },
              },
              input.pullRequest,
            );
            for (const branch of [adopted.branch, adopted.base])
              await connection.git(['check-ref-format', `refs/heads/${branch}`]);
            return adopted;
          },
        });
      }, true);
    },
  );
}
