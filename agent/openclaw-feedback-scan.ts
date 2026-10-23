import { workflowFeedbackAvailable } from '../channels/github/feedback-policy.ts';
import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import { GitHubWorkEventClientError } from '../channels/github/provider/work-event-api-client.ts';
import { GitHubAccountClientError } from '../core/github-account-client.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { automationHash } from './automation-hash.ts';
import DiscoveryBudget, { DiscoveryPaused } from './discovery-budget.ts';
import feedbackOwnPublications from './feedback-own-publications.ts';
import { discoverFeedback } from './feedback-source.ts';
import {
  type default as OpenClawDispatchContext,
  openClawDispatchFailureCode,
} from './openclaw-dispatch-context.ts';
import type { OpenClawDispatchRecord, OpenClawDispatchState } from './openclaw-dispatch-state.ts';
import { feedbackSession } from './openclaw-feedback.ts';

export function openClawFeedbackEnabled(manifest: AgentManifest) {
  return workflowFeedbackAvailable(manifest.github?.notifications, 'issue-assignment');
}
export interface OpenClawFeedbackScan {
  id: string;
  before: string;
  feedback: NonNullable<OpenClawDispatchRecord['feedback']>;
}

/** provider reads stay outside the journal lock; only unchanged owners accept the snapshot. */
export async function scanOpenClawFeedback(input: {
  service: Pick<OpenClawDispatchContext, 'scope' | 'dependencies' | 'validate'>;
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
    let before = automationHash(record);
    const feedback = structuredClone(
      record.feedback ?? { startedAt: now, baseline: {}, events: [] },
    );
    let target = record.id;
    let completed = budget.completed;
    const updateStallCode = () => {
      if (Object.values(feedback.discoveryStalls ?? {}).some((stall) => stall.attempts >= 3))
        feedback.code = 'feedback-discovery-no-progress';
      else if (feedback.code === 'feedback-discovery-no-progress') delete feedback.code;
    };
    const save = async () => {
      if (!input.checkpoint) return;
      await input.checkpoint({ id: record.id, before, feedback });
      record.feedback = structuredClone(feedback);
      before = automationHash(record);
    };
    if (budget.exhausted) {
      feedback.discoveryPending = true;
      const previous = feedback.discoveryStalls?.[record.id];
      (feedback.discoveryStalls ??= {})[record.id] = {
        operation: 'occurrence-budget-before-feedback',
        attempts: Math.min(3, (previous?.attempts ?? 0) + 1),
      };
      updateStallCode();
      try {
        await save();
        scans.push({ id: record.id, before, feedback });
      } catch (error) {
        if (!(error instanceof Error && error.message === 'discovery-checkpoint-changed'))
          throw error;
      }
      break;
    }
    feedback.scannedTime = now;
    feedback.discoveryPending = true;
    try {
      await save();
      {
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
            fresh.manifest.agent.id !== manifest.agent.id ||
            fresh.scope.workspaceDir !== input.workspace
          )
            throw new Error('feedback-workspace-binding-changed');
        };
        await budget.read('workspace-binding', validateLocal);
        if (!connection) {
          connection = await budget.read('github-connection', () =>
            service.dependencies.connect(
              { manifest, workspaceDir: input.workspace },
              budget.signal,
            ),
          );
          const { store } = await service.scope(manifest, input.workspace);
          await budget.read('feedback-identities', () =>
            new GitHubIdentityCache(store.location).resolve(
              manifest.github?.notifications,
              connection!,
              'feedback',
              true,
            ),
          );
        }
        const { intake } = await budget.read('assignment-validation', () =>
          service.validate(
            manifest,
            input.workspace,
            record,
            false,
            true,
            connection,
            budget.signal,
          ),
        );
        provider ??= await budget.read('feedback-connection', async () =>
          service.dependencies.feedbackConnect?.(
            { manifest, workspaceDir: input.workspace },
            budget.signal,
            connection,
          ),
        );
        if (!provider) throw new Error('feedback-provider-unavailable');
        let publications: Promise<string[]> | undefined;
        const common = {
          state: feedback,
          ownCommentIds: () =>
            (publications ??= budget.read('own-publications', () =>
              feedbackOwnPublications({
                record,
                intake,
                client: provider!,
                announcement: record.work?.delivery?.announcement,
              }),
            )),
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
        let served = false;
        for (const source of sources) {
          budget.check();
          target = source.nodeId;
          completed = budget.completed;
          budget.operation = 'source-validation';
          if (feedback.discoveryStalls?.[record.id]?.operation !== 'session-activity')
            delete feedback.discoveryStalls?.[record.id];
          if (!served) feedback.lastSource = source.nodeId;
          served = true;
          await save();
          if (source.itemType === 'pull-request') {
            const item = await provider.getItem(common.owner, common.name, source.number);
            if (item.nodeId !== source.nodeId || item.itemType !== 'pull-request')
              throw new Error('feedback-source-owner-changed');
            if (item.state !== 'open') continue;
          }
          invalidate(source.nodeId, await discoverFeedback({ ...common, ...source }));
          delete feedback.discoveryStalls?.[target];
          updateStallCode();
        }
        target = record.id;
        completed = budget.completed;
        budget.operation = 'session-activity';
        budget.check();
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
        delete feedback.discoveryStalls?.[record.id];
        delete feedback.code;
        updateStallCode();
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'discovery-checkpoint-changed') continue;
      if (error instanceof DiscoveryPaused || budget.exhausted) {
        if (budget.completed > completed) delete feedback.discoveryStalls?.[target];
        else {
          const previous = feedback.discoveryStalls?.[target];
          (feedback.discoveryStalls ??= {})[target] = {
            operation: budget.operation,
            attempts: Math.min(3, (previous?.attempts ?? 0) + 1),
          };
        }
        updateStallCode();
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
