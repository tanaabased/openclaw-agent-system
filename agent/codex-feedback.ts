import { resolve } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import { type GitHubCanonicalFeedback } from '../channels/github/provider/review-feedback.ts';
import { implementationMaterialSchema } from '../tools/dispatch/implementation-material-schema.ts';
import { automationHash } from './automation-hash.ts';
import { inspectCodexDispatchActivation } from './codex-automations.ts';
import codexContinuationNative from './codex-continuation-native.ts';
import type { CodexDispatchDependencies } from './codex-dispatch-context.ts';
import { codexDispatchNative } from './codex-dispatch-native.ts';
import unsubmittedNativeRequest from './codex-dispatch-unsubmitted.ts';
import { codexFeedbackHandoff } from './codex-dispatch-handoff.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import authorizeCodexFeedback from './codex-feedback-authority.ts';
import connectCodexFeedback from './codex-feedback-client.ts';
import { applyFeedbackScans, scanCodexFeedback } from './codex-feedback-scan.ts';
import codexHostAccess from './codex-host-access.ts';
import { selectCodexIntake } from './codex-intake.ts';
import codexReply from './codex-reply.ts';
import codexSessionSettings from './codex-session-settings.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import DiscoveryBudget from './discovery-budget.ts';
import discoveryCheckpoint from './discovery-checkpoint.ts';
import { dispatchFailurePhase, dispatchRetryDue, scheduleDispatchRetry } from './dispatch-retry.ts';
import feedbackContextMaterial from './feedback-context-material.ts';
import { feedbackConversationMode } from './feedback-conversation-mode.ts';
import { feedbackInputContext } from './feedback-input.ts';
import feedbackPresentation from './feedback-presentation.ts';
import { observeFeedbackPolicy } from './feedback-source.ts';
import { retainedIssueProgression } from './issue-progression.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { dispatchAdmission } from './managed-issue.ts';
import type { OpenClawFeedbackProvider } from './openclaw-feedback.ts';
import retainedIntakePolicy from './retained-intake-policy.ts';
import workflowFailure from './workflow-failure.ts';
import { requireWorkflowSchedule } from './workflow-schedule.ts';
const requestSchema = Type.Object(
  {
    action: Type.Union([Type.Literal('next'), Type.Literal('context'), Type.Literal('reconcile')]),
    id: Type.Optional(Type.String()),
    material: Type.Optional(implementationMaterialSchema),
    eventId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export interface CodexFeedbackDependencies extends CodexDispatchDependencies {
  replyConnection?: typeof connectCodexThreads;
  replyProvider?: (workspace: string, signal: AbortSignal) => Promise<OpenClawFeedbackProvider>;
  feedbackConnect?: typeof connectCodexFeedback;
  continuationNative?: ReturnType<typeof codexContinuationNative>;
  nativeRequest?: Parameters<typeof unsubmittedNativeRequest>[0];
}
/** the existing intake owns sends; feedback has no independent scheduler or work authority. */
export default async function runCodexFeedback(
  pluginData: string,
  input: unknown,
  deps: CodexFeedbackDependencies = {},
) {
  if (input && typeof input === 'object' && 'action' in input && input.action === 'reply')
    return codexReply(pluginData, input, deps);
  if (
    !Value.Check(requestSchema, input) ||
    (input.action !== 'next' && (!input.id || !input.eventId)) ||
    (input.material !== undefined && input.action !== 'context')
  )
    throw new Error('feedback-request-invalid');
  const current = await selectCodexIntake(pluginData, deps);
  const admittedState = await current.store.read();
  const selected =
    current.policy ??
    (admittedState ? retainedIntakePolicy(current.manifest, admittedState, 'codex') : undefined);
  const policy = selected?.policy;
  const store = new CodexDispatchStore(current.store.location.root, current.store.location.scope);
  if (!policy || !selected) return { status: 'disabled' };
  current.policy = selected;
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('feedback-caller-required');
  const nativeContext =
    input.action !== 'next' &&
    (await store.read()).records.some(
      (record) =>
        record.id === input.id &&
        record.threadId === caller &&
        record.feedback?.events.some((event) => event.id === input.eventId),
    );
  const activation = nativeContext
    ? undefined
    : await (deps.activation ?? inspectCodexDispatchActivation)(
        pluginData,
        { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
        false,
        true,
        'feedback',
      );
  const schedule = activation?.schedule;
  if (
    !nativeContext &&
    ['next', 'reconcile'].includes(input.action) &&
    caller !== activation!.sourceThreadId
  )
    throw new Error('feedback-schedule-caller-required');
  const nativeConnection = deps.native
    ? undefined
    : await connectCodexThreads(current.workspace, current.codexHome);
  const native = deps.native ?? codexDispatchNative(nativeConnection!.request);
  const receiptFor: ReturnType<typeof codexContinuationNative> =
    deps.continuationNative ??
    (async (...args) => {
      const host =
        nativeConnection ?? (await connectCodexThreads(current.workspace, current.codexHome));
      try {
        return await codexContinuationNative(host.request)(...args);
      } finally {
        if (!nativeConnection) await host.close();
      }
    });
  try {
    const occurrence =
      !nativeContext && ['next', 'reconcile'].includes(input.action)
        ? await native.occurrence(caller)
        : undefined;
    if (occurrence && schedule && occurrence.automationId !== schedule.current.automationId)
      throw new Error('feedback-occurrence-mismatch');
    const snapshot = input.action === 'next' ? await store.read() : undefined;
    const budget = new DiscoveryBudget();
    const scanTime = (deps.now ?? Date.now)();
    let discoveryFailure: ReturnType<typeof workflowFailure> | undefined;
    const scans =
      snapshot && occurrence && snapshot.records.some((record) => record.threadId)
        ? await (async () =>
            scanCodexFeedback({
              state: snapshot,
              budget,
              checkpoint: (scan) => discoveryCheckpoint(store, scan),
              current,
              occurrence: occurrence.id,
              sourceThreadId: activation!.sourceThreadId,
              now: scanTime,
              provider: await (deps.feedbackConnect ?? connectCodexFeedback)(
                current.workspace,
                budget.signal,
              ),
            }))().catch((error: unknown) => {
            discoveryFailure = workflowFailure(error, 'feedback-discovery-unavailable');
            return [];
          })
        : [];
    if (scans.length) {
      const fresh = await (deps.activation ?? inspectCodexDispatchActivation)(
        pluginData,
        { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
        false,
        true,
        'feedback',
      );
      if (fresh.sourceThreadId !== activation!.sourceThreadId)
        throw new Error('feedback-schedule-owner-changed');
    }
    const response = await store.exclusive(async (state, save, signal) => {
      if (applyFeedbackScans(state.records, scans)) await save();
      if (input.action === 'next') {
        let policyObserved = false;
        for (const record of state.records) {
          if (record.supersededBy || record.reset || !record.feedback) continue;
          const enabled = record.feedback.admission?.enabled;
          const observedAt = record.feedback.admission?.observedAt;
          observeFeedbackPolicy(record.feedback, current.manifest.github?.notifications, scanTime);
          policyObserved ||=
            enabled !== record.feedback.admission?.enabled ||
            observedAt !== record.feedback.admission?.observedAt;
        }
        if (policyObserved) await save();
      }
      if (snapshot && occurrence) {
        const cycleAt = state.discoveryCycleAt ?? scanTime;
        const owners = state.records.filter(
          (r) => !r.supersededBy && !r.retirement && !r.reset && r.threadId,
        );
        if (
          owners.some(
            (r) =>
              (r.feedback?.scannedTime ?? 0) < cycleAt ||
              r.feedback?.discoveryPending ||
              Object.keys(r.feedback?.discovery ?? {}).length,
          )
        )
          state.discoveryCycleAt = cycleAt;
        else delete state.discoveryCycleAt;
        await save();
      }
      const intake = await current.store.read();
      if (!intake) throw new Error('feedback-intake-missing');
      const now = (deps.now ?? Date.now)();
      if (!state.records.some((record) => record.threadId)) return { status: 'idle' };
      let connection: Awaited<ReturnType<typeof connectCodexFeedback>> | undefined;
      const providerFor = async () => {
        if (!connection) {
          connection = await (deps.feedbackConnect ?? connectCodexFeedback)(
            current.workspace,
            signal,
          );
          await new GitHubIdentityCache(current.store.location).resolve(
            current.manifest.github?.notifications,
            connection.client,
            'feedback',
          );
        }
        return connection;
      };
      const records = state.records.filter(
        (record) =>
          !record.supersededBy &&
          !record.reset &&
          record.threadId &&
          record.request &&
          record.worktree,
      );
      if (
        input.action === 'next' &&
        !records.some((record) =>
          record.feedback?.events.some(
            (event) =>
              (event.attempt && !['delivered'].includes(event.phase)) ||
              (!event.policyHeld && ['queued', 'prepared', 'running'].includes(event.phase)),
          ),
        )
      )
        return { status: 'idle' };
      const queuedEvent = (record: (typeof records)[number]) =>
        record.feedback?.events
          .filter((event) => event.phase === 'queued' && !event.policyHeld)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
      const readyAt = (record: (typeof records)[number]) =>
        Math.max(queuedEvent(record)?.createdAt ?? Infinity, record.feedback?.lastServedAt ?? 0);
      records.sort((a, b) => readyAt(a) - readyAt(b));
      for (const record of records) {
        if (input.action !== 'next' && record.id !== input.id) continue;
        const feedback = (record.feedback ??= { startedAt: now, baseline: {}, events: [] });
        const events =
          input.action === 'next'
            ? feedback.events
                .filter(
                  (event) =>
                    (event.attempt && !['delivered'].includes(event.phase)) ||
                    (event.phase === 'queued' && !event.policyHeld),
                )
                .sort((a, b) => a.createdAt - b.createdAt)
            : [feedback.events.find((event) => event.id === input.eventId)];
        // An uncertain receipt belongs to that input; it cannot hold a different comment.
        for (const event of events) {
          let sourcePresentation: string | undefined;
          try {
            if (event?.attempt && ['next', 'reconcile'].includes(input.action)) {
              if (event.attempt.request.threadId !== record.threadId)
                throw new Error('feedback-native-binding-mismatch');
              const receipt = await receiptFor(record.sourceThreadId, event.attempt);
              if (receipt.status === 'blocked') {
                event.phase = 'blocked';
                event.code = receipt.code;
                if ('turnId' in receipt) event.attempt.turnId = receipt.turnId;
                await save();
                continue;
              }
              if (receipt.status === 'verified') {
                if ('turnId' in receipt) event.attempt.turnId = receipt.turnId;
                event.phase = 'delivered';
                feedback.lastServedAt = now;
                delete record.nativeInactive;
                delete record.capacityObservation;
                delete event.code;
                delete event.retry;
                delete event.retryAfter;
                await save();
                continue;
              }
              // Recover only a completed sender turn with complete native proof that no
              // send was invoked. Missing acknowledgments and actual refusals never replay.
              const sender = event.attempt.sourceThreadId ?? record.sourceThreadId;
              const historyRequest = nativeConnection?.request ?? deps.nativeRequest;
              const unsubmitted =
                input.action === 'next' &&
                historyRequest &&
                (await unsubmittedNativeRequest(
                  historyRequest,
                  sender,
                  {
                    turnId: event.attempt.sourceTurnId,
                    threadId: event.attempt.request.threadId,
                  },
                  sender === caller ? occurrence?.id : undefined,
                  'send_message_to_thread',
                ));
              if (!unsubmitted) {
                event.code = 'feedback-send-unresolved';
                await save();
                if (input.action === 'reconcile')
                  return {
                    status: 'uncertain',
                    code: event.code,
                    id: record.id,
                    eventId: event.id,
                  };
                continue;
              }
              delete event.attempt;
              delete event.code;
              event.phase = 'queued';
              await save();
            }
            const provider = await providerFor();
            const admitted = dispatchAdmission(record, intake.records ?? []);
            if (!admitted) throw new Error('feedback-admission-missing');
            const owner = admitted.repository.owner.login,
              name = admitted.repository.name;
            if (!event || record.retirement) continue;
            if (!nativeContext) {
              if (!schedule) throw new Error('workflow-schedule-reconciliation-required');
              requireWorkflowSchedule(schedule.saved, schedule.current, 'feedback');
            }
            if (input.action === 'next' && event.retry && !dispatchRetryDue(event, now)) continue;
            if (
              (event.phase === 'delivered' && ['next', 'reconcile'].includes(input.action)) ||
              event.phase === 'blocked'
            )
              return { status: event.phase, id: record.id, eventId: event.id, code: event.code };
            if (input.action === 'context' && caller !== record.threadId)
              throw new Error('feedback-owner-caller-required');
            const source = JSON.parse(event.source) as GitHubCanonicalFeedback;
            sourcePresentation = feedbackPresentation(event, owner + '/' + name);
            const selfFeedback = source.author?.nodeId === provider.comments.identity.nodeId;
            const authorize = async () => {
              if (!nativeContext) {
                const fresh = await (deps.activation ?? inspectCodexDispatchActivation)(
                  pluginData,
                  { codexHome: current.codexHome, inspectBinding: deps.inspectBinding },
                  false,
                  true,
                  'feedback',
                );
                if (fresh.sourceThreadId !== activation!.sourceThreadId)
                  throw new Error('feedback-schedule-owner-changed');
              }
              const live = await selectCodexIntake(pluginData, deps);
              await authorizeCodexFeedback({
                conversation: true,
                current: live,
                record,
                event,
                intake: admitted,
                provider,
              });
            };
            await authorize();
            delete event.policyHeld;
            const found = await native.find({
              sourceThreadId: record.sourceThreadId,
              prompt: record.request!.prompt,
              createdAfter: record.createdAt,
              threadId: record.threadId,
            });
            if (
              !found?.turnId ||
              found.id !== record.threadId ||
              resolve(found.cwd) !== resolve(record.worktree!)
            )
              throw new Error('feedback-native-binding-mismatch');
            if (!input.material) {
              record.effective = codexSessionSettings(record, found);
              await save();
            }
            if (event.attempt) {
              const receipt = await receiptFor(record.sourceThreadId, event.attempt);
              if (receipt.status === 'blocked') throw new Error(receipt.code);
              if (receipt.status === 'uncertain') {
                if (input.action === 'next') continue;
                return { status: 'uncertain', id: record.id, eventId: event.id };
              }
              if (event.attempt.turnId && event.attempt.turnId !== receipt.turnId)
                throw new Error('feedback-turn-changed');
              if (!input.material) {
                event.attempt.turnId = receipt.turnId;
                delete event.retry;
                delete event.retryAfter;
                if (event.phase === 'prepared') event.phase = 'running';
                if (
                  receipt.ended &&
                  found.turnEnded &&
                  ['idle', 'notLoaded'].includes(found.status)
                )
                  record.nativeInactive = true;
                else delete record.nativeInactive;
                delete record.capacityObservation;
                {
                  event.phase = 'delivered';
                  feedback.lastServedAt = now;
                  delete event.code;
                }
                await save();
              }
              if (input.action === 'next' || input.action === 'reconcile') continue;
            } else {
              if (input.action !== 'next') throw new Error('feedback-send-unverified');
              if (!['idle', 'notLoaded'].includes(found.status) || found.turnEnded !== true)
                continue;
              const id = automationHash([event.id, occurrence!.id, found.turnId]);
              event.attempt = {
                id,
                sourceThreadId: activation!.sourceThreadId,
                sourceTurnId: occurrence!.id,
                beforeTurnId: found.turnId,
                request: {
                  threadId: record.threadId!,
                  prompt: sourcePresentation,
                },
              };
              delete record.nativeInactive;
              delete record.capacityObservation;
              event.phase = 'prepared';
              await save();
              return {
                status: 'feedback-prepared',
                id: record.id,
                eventId: event.id,
                request: event.attempt.request,
                nativeHandoff: codexFeedbackHandoff(event.attempt.request),
              };
            }
            {
              return {
                ...feedbackInputContext({
                  runtime: 'codex',
                  event,
                  repository: owner + '/' + name,
                  mode: feedbackConversationMode(
                    record,
                    (await selectCodexIntake(pluginData, deps)).manifest.github!.notifications!,
                  ),
                  issueStage: retainedIssueProgression(record)?.stage ?? 'planning',
                  self: selfFeedback,
                }),
                id: record.id,
                eventId: event.id,
                presentation: sourcePresentation,
                continuationRequest: { action: 'context' as const, id: record.id },
                project: { path: record.worktree },
              };
            }
          } catch (error) {
            if (error instanceof WorkflowPolicyHeld && event) {
              event.policyHeld = error.reason;
              await save();
              if (input.action === 'next') continue;
              return {
                status: 'policy-held',
                id: record.id,
                eventId: event.id,
                reason: error.reason,
              };
            }
            if (codexHostAccess(error)) throw error;
            const failure = workflowFailure(error, 'feedback-operation-failed');
            const { code } = failure;
            if (!event) feedback.code = code;
            if (event) {
              event.code = code;
              scheduleDispatchRetry(event, code, error, now);
            }
            if (
              event &&
              !event.retry &&
              /^(?:feedback-(?:source-changed|source-identity-changed|source-author-changed|source-no-longer-eligible|source-owner-changed|authority-changed|turn-changed|native-binding-mismatch|self-publication-denied)|github-notification-publication-(?:text|secret|commenter|output|reconciliation)|continuation-native|dispatch-.*(?:revoked|diverged))/.test(
                code,
              )
            ) {
              event.phase = 'blocked';
              event.code = code;
            }
            if (event && dispatchFailurePhase(event, code, error) === 'blocked')
              event.phase = 'blocked';
            await save();
            if (input.action !== 'next')
              return {
                status:
                  event?.phase === 'blocked'
                    ? 'blocked'
                    : dispatchFailurePhase(event ?? {}, code, error),
                id: record.id,
                eventId: input.eventId,
                ...failure,
              };
          }
        }
      }
      return { status: 'idle' };
    }, !['next', 'reconcile'].includes(input.action));
    if (
      ['context', 'implementation-context'].includes(input.action) &&
      response.status === 'verified'
    )
      return feedbackContextMaterial(
        response,
        { action: input.action, id: input.id, eventId: input.eventId },
        input.material,
      );
    return discoveryFailure ? { ...response, discoveryFailure } : response;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'private-state-file-lock-busy'
    )
      return {
        status: 'busy',
        instruction:
          'Retry this exact request after two seconds, at most three times. Do not repeat a native send.',
      };
    throw error;
  } finally {
    await nativeConnection?.close();
  }
}
