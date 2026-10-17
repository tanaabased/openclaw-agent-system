import { automationHash } from './automation-hash.ts';
import { discoverFeedback } from './feedback-source.ts';
import { feedbackSession } from './openclaw-feedback.ts';
import {
  type default as OpenClawDispatch,
  openClawDispatchFailureCode,
} from './openclaw-dispatch.ts';
import type { OpenClawDispatchRecord, OpenClawDispatchState } from './openclaw-dispatch-state.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import { feedbackIdentities } from '../channels/github/feedback-policy.ts';

export function openClawFeedbackEnabled(manifest: AgentManifest) {
  const policy = manifest.github?.notifications;
  return (
    policy?.schemaVersion === 2 &&
    feedbackIdentities(policy.issueAssignment?.allowed ?? [], policy.issueAssignment?.feedback)
      .length > 0
  );
}
export interface OpenClawFeedbackScan {
  id: string;
  before: string;
  feedback: NonNullable<OpenClawDispatchRecord['feedback']>;
}

/** provider reads stay outside the journal lock; only unchanged owners accept the snapshot. */
export async function scanOpenClawFeedback(input: {
  service: OpenClawDispatch;
  state: OpenClawDispatchState;
  manifest: AgentManifest;
  workspace: string;
  sourceThreadId: string;
  authority: DispatchAuthority;
  now: number;
}) {
  const { service, manifest, now } = input;
  const enabled = openClawFeedbackEnabled(manifest);
  if (!enabled && !input.state.records.some((record) => record.feedback)) return [];
  const scans: OpenClawFeedbackScan[] = [];
  const records = input.state.records
    .filter(
      (record) =>
        !record.retired && !record.reset && record.sessionCreation?.verified && record.threadId,
    )
    .sort((a, b) => (a.feedback?.scannedTime ?? 0) - (b.feedback?.scannedTime ?? 0))
    .slice(0, 12);
  for (const record of records) {
    const before = automationHash(record);
    const feedback = structuredClone(
      record.feedback ?? { startedAt: now, baseline: {}, events: [] },
    );
    try {
      if (!enabled) {
        for (const event of feedback.events)
          if (!['published', 'blocked'].includes(event.phase)) {
            event.phase = 'blocked';
            event.code = 'feedback-authority-revoked';
          }
        delete feedback.activity;
        delete feedback.code;
      } else {
        if (record.sourceThreadId !== input.sourceThreadId)
          throw new Error('feedback-schedule-owner-changed');
        const validate = async () => {
          await input.authority.assertCurrent?.();
          if (
            (await service.dependencies.coordinator(manifest, input.workspace)) !==
            input.sourceThreadId
          )
            throw new Error('feedback-schedule-owner-changed');
          return service.validate(manifest, input.workspace, record, false, true);
        };
        const { intake } = await validate();
        const provider = await service.dependencies.feedbackConnect?.(
          { manifest, workspaceDir: input.workspace },
          input.authority.signal ?? AbortSignal.timeout(60000),
        );
        if (!provider) throw new Error('feedback-provider-unavailable');
        const common = {
          state: feedback,
          client: provider,
          policy: manifest.github!.notifications!,
          now,
          owner: intake.repository.owner.login,
          name: intake.repository.name,
        };
        const invalidate = (nodeId: string, revisions: Map<string, string>) => {
          for (const event of feedback.events)
            if (
              event.nodeId === nodeId &&
              !['published', 'blocked'].includes(event.phase) &&
              revisions.get(event.sourceId) !== event.revision
            ) {
              event.phase = 'blocked';
              event.code = 'feedback-source-changed';
            }
        };
        invalidate(
          intake.issue.nodeId,
          await discoverFeedback({
            ...common,
            number: intake.issue.number,
            nodeId: intake.issue.nodeId,
            itemType: 'issue',
          }),
        );
        const pr = record.work?.delivery?.reconciled ? record.work.delivery.pullRequest : undefined;
        if (pr) {
          const item = await provider.getItem(common.owner, common.name, pr.pullRequestNumber);
          if (item.nodeId !== pr.pullRequestNodeId || item.itemType !== 'pull-request')
            throw new Error('feedback-source-owner-changed');
          if (item.state === 'open')
            invalidate(
              pr.pullRequestNodeId,
              await discoverFeedback({
                ...common,
                number: pr.pullRequestNumber,
                nodeId: pr.pullRequestNodeId,
                itemType: 'pull-request',
              }),
            );
          else invalidate(pr.pullRequestNodeId, new Map());
        }
        const activity = await service.dependencies.credential.use(
          {
            ...input.authority,
            assertCurrent: async () => {
              await validate();
            },
          },
          (request) => feedbackSession(request, record, service.dependencies.config()),
        );
        feedback.activity = { busy: activity.busy, observedAt: now };
        await validate();
        delete feedback.code;
      }
    } catch (error) {
      feedback.code = openClawDispatchFailureCode(error);
      if (/revoked|policy-changed|owner-changed/.test(feedback.code)) {
        for (const event of feedback.events)
          if (!['published', 'blocked'].includes(event.phase)) {
            event.phase = 'blocked';
            event.code = feedback.code;
          }
      }
    }
    feedback.scannedTime = now;
    scans.push({ id: record.id, before, feedback });
  }
  return scans;
}

export function applyOpenClawFeedbackScans(
  records: OpenClawDispatchRecord[],
  scans: OpenClawFeedbackScan[],
) {
  let changed = false;
  for (const scan of scans) {
    const record = records.find((record) => record.id === scan.id);
    if (record && automationHash(record) === scan.before) {
      record.feedback = scan.feedback;
      changed = true;
    }
  }
  return changed;
}
