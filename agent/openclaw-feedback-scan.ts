import feedbackOwnPublications from './feedback-own-publications.ts';
import { GitHubAccountClientError } from '../core/github-account-client.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import DiscoveryBudget, { DiscoveryPaused } from './discovery-budget.ts';
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
  budget?: DiscoveryBudget;
  checkpoint?(scan: OpenClawFeedbackScan): Promise<void>;
}) {
  const { service, manifest, now } = input;
  const budget = input.budget ?? new DiscoveryBudget(20000, input.authority.signal);
  const enabled = openClawFeedbackEnabled(manifest);
  if (!enabled && !input.state.records.some((record) => record.feedback)) return [];
  const scans: OpenClawFeedbackScan[] = [];
  const records = input.state.records
    .filter(
      (record) =>
        !record.retired &&
        !record.retirement &&
        !record.reset &&
        record.sessionCreation?.verified &&
        record.threadId,
    )
    .sort((a, b) => (a.feedback?.scannedTime ?? 0) - (b.feedback?.scannedTime ?? 0))
    .slice(0, 12);
  let connection: Awaited<ReturnType<typeof service.dependencies.connect>> | undefined;
  let provider:
    Awaited<ReturnType<NonNullable<typeof service.dependencies.feedbackConnect>>> | undefined;
  for (const record of records) {
    if (budget.exhausted) break;
    let before = automationHash(record);
    const feedback = structuredClone(
      record.feedback ?? { startedAt: now, baseline: {}, events: [] },
    );
    const save = async () => {
      if (!input.checkpoint) return;
      await input.checkpoint({ id: record.id, before, feedback });
      record.feedback = structuredClone(feedback);
      before = automationHash(record);
    };
    feedback.scannedTime = now;
    feedback.discoveryPending = true;
    try {
      await save();
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
        const validateLocal = async () => {
          budget.check();
          await input.authority.assertCurrent?.();
          if (
            (await service.dependencies.coordinator(manifest, input.workspace)) !==
            input.sourceThreadId
          )
            throw new Error('feedback-schedule-owner-changed');
          const fresh =
            await service.dependencies.intake.dependencies.manifestService.loadForAgentId(
              manifest.agent.id,
              'service',
            );
          if (
            fresh.status !== 'loaded' ||
            automationHash(fresh.manifest) !== automationHash(manifest)
          )
            throw new Error('feedback-policy-changed');
        };
        await validateLocal();
        connection ??= await service.dependencies.connect(
          { manifest, workspaceDir: input.workspace },
          budget.signal,
        );
        const { intake } = await service.validate(
          manifest,
          input.workspace,
          record,
          false,
          true,
          connection,
          budget.signal,
        );
        provider ??= await service.dependencies.feedbackConnect?.(
          { manifest, workspaceDir: input.workspace },
          budget.signal,
          connection,
        );
        if (!provider) throw new Error('feedback-provider-unavailable');
        let publications: Promise<string[]> | undefined;
        const common = {
          state: feedback,
          ownCommentIds: () =>
            (publications ??= feedbackOwnPublications({
              record,
              intake,
              client: provider!,
              announcement: record.work?.delivery?.announcement,
            })),
          client: provider,
          policy: manifest.github!.notifications!,
          now,
          ...(input.checkpoint ? { discovery: { budget, save } } : {}),
          owner: intake.repository.owner.login,
          name: intake.repository.name,
        };
        const invalidate = (nodeId: string, revisions: Map<string, string>) => {
          for (const event of feedback.events)
            if (
              event.nodeId === nodeId &&
              !['published', 'blocked'].includes(event.phase) &&
              revisions.has(event.sourceId) &&
              revisions.get(event.sourceId) !== event.revision
            ) {
              event.phase = 'blocked';
              event.code = 'feedback-source-changed';
            }
        };
        const pr = record.work?.delivery?.reconciled ? record.work.delivery.pullRequest : undefined;
        const sources = [
          { number: intake.issue.number, nodeId: intake.issue.nodeId, itemType: 'issue' as const },
          ...(pr
            ? [
                {
                  number: pr.pullRequestNumber,
                  nodeId: pr.pullRequestNodeId,
                  itemType: 'pull-request' as const,
                },
              ]
            : []),
        ].sort(
          (a, b) =>
            Number(a.nodeId === feedback.lastSource) - Number(b.nodeId === feedback.lastSource),
        );
        for (const source of sources) {
          budget.check();
          feedback.lastSource = source.nodeId;
          await save();
          if (source.itemType === 'pull-request') {
            const item = await provider.getItem(common.owner, common.name, source.number);
            if (item.nodeId !== source.nodeId || item.itemType !== 'pull-request')
              throw new Error('feedback-source-owner-changed');
            if (item.state !== 'open') continue;
          }
          invalidate(source.nodeId, await discoverFeedback({ ...common, ...source }));
        }
        const activity = await service.dependencies.credential.use(
          {
            ...input.authority,
            assertCurrent: async () => {
              await validateLocal();
            },
          },
          (request) => feedbackSession(request, record, service.dependencies.config()),
        );
        feedback.activity = { busy: activity.busy, observedAt: now };
        await validateLocal();
        delete feedback.code;
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'discovery-checkpoint-changed') continue;
      if (error instanceof DiscoveryPaused || budget.exhausted) {
        await save();
        scans.push({ id: record.id, before, feedback });
        continue;
      }
      if (error instanceof Error && /discovery-checkpoint|private-state-file/.test(error.message))
        throw error;
      if (
        (error instanceof GitHubAccountClientError ||
          error instanceof GitHubWorkEventClientError) &&
        error.providerDiagnostic?.classification === 'rate-limit'
      ) {
        feedback.code = 'feedback-github-rate-limit';
        await save();
        scans.push({ id: record.id, before, feedback });
        break;
      }
      feedback.code = openClawDispatchFailureCode(error);
      if (/revoked|owner-changed/.test(feedback.code)) {
        for (const event of feedback.events)
          if (!['published', 'blocked'].includes(event.phase)) {
            event.phase = 'blocked';
            event.code = feedback.code;
          }
      }
    }
    feedback.discoveryPending = false;
    feedback.scannedTime = now;
    await save();
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
