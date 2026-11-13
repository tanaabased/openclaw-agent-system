import { issuePullRequestRecipients } from '../../../channels/github/pull-request-recipients.ts';
import feedbackPresentation from '../feedback/feedback-presentation.ts';
import issueWorkflowMode from '../issue-workflow-mode.ts';
import {
  dispatchAdmission,
  type ManagedIssue as IntakeRecord,
  managedPullRequest,
  managedTargetUrl,
} from '../managed-issue.ts';
import {
  resolveOpenClawTurnFeedback,
  selectedOpenClawFeedback,
} from '../feedback/openclaw-feedback-input.ts';
import { nativeTurnFor } from '../../openclaw-native-turns.ts';
import { nativeInputEvent, operatorInputEvent } from '../../openclaw-session-input.ts';
import taskPullRequest, { isCurrentTaskPullRequest } from '../delivery/task-pull-request.ts';
import workflowStatus from '../workflow-status.ts';

import type { Static } from 'typebox';
import GitHubIdentityCache from '../../../channels/github/identity-cache.ts';

import { privateStateFileLockBusyErrorCode } from '../../../core/private-state-file-lock.ts';
import type { DispatchAuthority } from '../../../credentials/session-dispatch.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import type { dispatchParameters } from '../../../tools/dispatch/tool-schema.ts';
import assessmentReviewContext from '../assessment/assessment-review-context.ts';
import {
  dispatchFailurePhase,
  dispatchFailureStatus,
  dispatchRetryDue,
  scheduleDispatchRetry,
} from './dispatch-retry.ts';
import selectFeedbackStage from '../feedback/feedback-stage.ts';
import { WorkflowPolicyHeld } from '../live-workflow-policy.ts';
import {
  issueAssessmentAction,
  selectOpenClawAssessment,
} from '../assessment/openclaw-assessment.ts';
import advanceOpenClawWork from '../implementation/openclaw-continuation.ts';
import openClawDelivery, { presentOpenClawDelivery } from '../delivery/openclaw-delivery.ts';
import openClawDeliveryRecovery from '../delivery/openclaw-delivery-recovery.ts';
import {
  type default as OpenClawDispatchContext,
  openClawDispatchFailureCode,
  type OpenClawDispatchTransaction,
  type OpenClawDispatchValidation,
} from './openclaw-dispatch-context.ts';

import { type OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { openClawFeedbackEnabled } from '../feedback/openclaw-feedback-scan.ts';
import type { OpenClawFeedbackEvent } from '../feedback/openclaw-feedback-state.ts';
import openClawFeedback, {
  advanceFeedbackTurn,
  authorizeFeedback,
  type OpenClawFeedbackAction,
} from '../feedback/openclaw-feedback.ts';
import { describeIssueSession, type DispatchCaller } from '../../openclaw-session-create.ts';
import openClawSkill from '../../openclaw-skill.ts';
import openClawWorkAction, { verifyOpenClawWork } from '../implementation/openclaw-work.ts';
import workflowFailure from '../workflow-failure.ts';
import workflowRecovery from '../workflow-recovery.ts';
import { selectWorkflowStage } from '../workflow-stage.ts';

function source(intake: IntakeRecord) {
  return managedTargetUrl(intake);
}
export default class OpenClawDispatchIssue {
  constructor(readonly context: OpenClawDispatchContext) {}
  async continueWork(
    manifest: AgentManifest,
    workspace: string,
    record: OpenClawDispatchRecord,
    save: () => Promise<void>,
    authority: DispatchAuthority & { caller?: DispatchCaller },
  ) {
    const assertCurrent = async () => {
      await authority.assertCurrent?.();
      authority.signal?.throwIfAborted();
      await this.context.validateLocal(manifest, workspace, record, false, 'native');
    };
    try {
      await assertCurrent();
      return await this.context.dependencies.credential.use(
        { ...authority, assertCurrent },
        async (request) => {
          const common = {
            record,
            request,
            save,
            assertCurrent,
            config: this.context.dependencies.config(),
          };
          const outcomes = [];
          const recoveries = [() => advanceOpenClawWork(common)];
          for (const recover of recoveries) {
            try {
              outcomes.push(await recover());
            } catch (error) {
              authority.signal?.throwIfAborted();
              outcomes.push(workflowFailure(error, 'dispatch-turn-reconciliation-unavailable'));
            }
          }
          return { status: 'reconciled' as const, id: record.id, outcomes };
        },
      );
    } catch (error) {
      const code = openClawDispatchFailureCode(error);
      return { status: 'implementation-pending' as const, id: record.id, code };
    }
  }

  async feedback(
    manifest: AgentManifest,
    workspace: string,
    record: OpenClawDispatchRecord,
    event: OpenClawFeedbackEvent,
    caller: DispatchCaller,
    action: OpenClawFeedbackAction | undefined,
    save: () => Promise<void>,
    authority: DispatchAuthority,
  ) {
    const now = (this.context.dependencies.now ?? Date.now)();
    if (!action && event.retry && !dispatchRetryDue(event, now))
      return {
        status: 'retrying' as const,
        id: record.id,
        eventId: event.id,
        code: event.code,
        nextAction: 'next',
      };
    const feedbackScope = 'native' as const;
    try {
      const assertCurrent = async () => {
        authority.signal?.throwIfAborted();
        await authority.assertCurrent?.();
        await this.context.validateLocal(manifest, workspace, record, false, feedbackScope);
      };
      await assertCurrent();
      // Once sent, native receipt recovery has no dependency on GitHub source availability.
      if (event.turn && (!action || action.operation === 'reconcile'))
        return await this.context.dependencies.credential.use(
          { ...authority, assertCurrent },
          async (request) => {
            const result = await advanceFeedbackTurn({
              record,
              event,
              request,
              save,
              assertCurrent,
              config: this.context.dependencies.config(),
            });
            return result;
          },
        );
      const { intake, client, item } = await this.context.validate(
        manifest,
        workspace,
        record,
        false,
        feedbackScope,
        undefined,
        authority.signal,
      );
      // Consume the entry validation once; later effect boundaries read again.
      let initialIssue: typeof item | undefined = item;
      const provider = await this.context.dependencies.feedbackConnect?.(
        { manifest, workspaceDir: workspace },
        authority.signal ?? AbortSignal.timeout(60000),
        client,
      );
      if (!provider) throw new Error('feedback-provider-unavailable');
      return await this.context
        .guardedCredential(() =>
          this.context.validate(
            manifest,
            workspace,
            record,
            false,
            feedbackScope,
            client,
            authority.signal,
          ),
        )
        .use({ ...authority, assertCurrent }, async (request) => {
          const common = {
            conversation: true,
            record,
            event,
            caller,
            request,
            config: this.context.dependencies.config(),
            provider,
            policy: (await this.context.scope(manifest, workspace)).policy.policy,
            intake,
            assertCurrent,
            livePolicy: async () => {
              const live = await this.context.validateLocal(
                manifest,
                workspace,
                record,
                false,
                feedbackScope,
              );
              return live.manifest.github!.notifications!;
            },
            reauthorize: async () => {
              if (initialIssue) {
                const observed = initialIssue;
                initialIssue = undefined;
                return observed;
              }
              return (
                await this.context.validate(
                  manifest,
                  workspace,
                  record,
                  false,
                  feedbackScope,
                  client,
                  authority.signal,
                )
              ).item;
            },
            save,
          };
          if (!action || action.operation === 'reconcile') {
            await authorizeFeedback(common);
            delete event.policyHeld;
            return advanceFeedbackTurn({
              ...common,
              sourcePresentation: feedbackPresentation(
                event,
                intake.repository.owner.login + '/' + intake.repository.name,
              ),
              authorizeInput: async () => {
                await authorizeFeedback(common);
              },
            });
          }
          return openClawFeedback({ ...common, action });
        });
    } catch (error) {
      // A failed context read cannot undo confirmed native delivery.
      const failedEvent = event.phase === 'delivered' ? { ...event } : event;
      if (error instanceof WorkflowPolicyHeld) {
        failedEvent.policyHeld = error.reason;
        if (failedEvent === event) await save();
        return {
          status: 'policy-held' as const,
          id: record.id,
          eventId: failedEvent.id,
          reason: error.reason,
          nextAction: 'next',
        };
      }
      const code = openClawDispatchFailureCode(error);
      failedEvent.code = code;
      scheduleDispatchRetry(failedEvent, code, error, now);
      // unknown transport outcomes retain custody; terminal failures release the queued work.
      if (
        !failedEvent.retry &&
        /revoked|authority-changed|owner-changed|source-(?:changed|identity-changed|author-changed|no-longer-eligible)|resource-missing|denied|turn-(?:failed|cancelled)|publication-(?:text|secret|output|reconciliation)|session-mismatch/.test(
          code,
        )
      ) {
        failedEvent.phase = 'blocked';
        if (failedEvent === event) record.feedback!.lastServedAt = now;
      }
      if (dispatchFailurePhase(failedEvent, code, error) === 'blocked')
        failedEvent.phase = 'blocked';
      if (failedEvent === event) await save();
      return {
        status:
          failedEvent.phase === 'blocked'
            ? 'blocked'
            : dispatchFailureStatus(failedEvent, code, error),
        id: record.id,
        eventId: failedEvent.id,
        nextAction: 'next',
        ...workflowFailure(error, code),
        code,
      };
    }
  }

  async routeFeedback(
    input: Static<typeof dispatchParameters>,
    record: OpenClawDispatchRecord,
    tx: OpenClawDispatchTransaction,
  ) {
    const { manifest, current, caller, save, authority, transactionSignal } = tx;
    const feedbackChild = input.action === 'feedback' && input.operation !== 'reconcile';
    if (input.action === 'feedback') {
      const event = record.feedback?.events.find((event) => event.id === input.eventId);
      if (!event) throw new Error('feedback-event-missing');
      if (input.operation === 'reconcile' && !event.turn)
        throw new Error('feedback-send-unverified');
      if (
        feedbackChild &&
        (caller.sessionKey !== record.threadId ||
          caller.sessionId !== record.sessionCreation?.sessionId)
      )
        throw new Error('feedback-owner-caller-required');
      return this.feedback(manifest, current.workspace, record, event, caller, input, save, {
        ...authority,
        signal: authority.signal
          ? AbortSignal.any([authority.signal, transactionSignal])
          : transactionSignal,
      });
    }
    const feedbackSource = selectedOpenClawFeedback(record, caller.runId);
    if (feedbackSource && input.action === 'context') {
      return this.feedback(
        manifest,
        current.workspace,
        record,
        feedbackSource,
        caller,
        { action: 'feedback', id: record.id, eventId: feedbackSource.id, operation: 'context' },
        save,
        authority,
      );
    }
  }
  async run(
    input: Static<typeof dispatchParameters>,
    record: OpenClawDispatchRecord,
    tx: OpenClawDispatchTransaction,
    verified: OpenClawDispatchValidation,
    operator: boolean,
  ) {
    const { manifest, workspace, caller, authority, current, save, transactionSignal, now } = tx;
    const { client, intake, repo } = verified;
    if (
      input.action === 'handoff' ||
      input.action === 'implementation-context' ||
      input.action === 'implementation-result' ||
      input.action === 'delivery'
    ) {
      const signal = authority.signal
        ? AbortSignal.any([authority.signal, transactionSignal])
        : transactionSignal;
      let feedbackEvent:
        NonNullable<OpenClawDispatchRecord['feedback']>['events'][number] | undefined;
      const assertCurrent = async () => {
        signal.throwIfAborted();
        await authority.assertCurrent?.();
        const live = await this.context.validateLocal(manifest, workspace, record, true);
        if (feedbackEvent) {
          const provider = await this.context.dependencies.feedbackConnect?.(
            { manifest: live.manifest, workspaceDir: workspace },
            signal,
            client,
          );
          if (!provider) throw new Error('feedback-provider-unavailable');
          await authorizeFeedback({
            conversation: true,
            record,
            event: feedbackEvent,
            intake,
            provider,
            policy: live.manifest.github!.notifications!,
            assertCurrent: async () => {
              await authority.assertCurrent?.();
            },
            reauthorize: async () =>
              (
                await this.context.validate(
                  manifest,
                  workspace,
                  record,
                  false,
                  'native',
                  client,
                  signal,
                )
              ).item,
          });
        }
        signal.throwIfAborted();
      };
      return this.context.dependencies.credential.use(
        { signal, assertCurrent },
        async (request) => {
          const nativeFeedback = await resolveOpenClawTurnFeedback(
            record,
            caller,
            request,
            this.context.dependencies.config(),
          );
          feedbackEvent = nativeFeedback?.event;
          await assertCurrent();
          if (
            input.action === 'implementation-context' &&
            input.scope &&
            !operator &&
            !nativeFeedback
          )
            throw new Error('implementation-operator-scope-required');
          const bindingOnly =
            input.action === 'delivery' &&
            (input.operation === 'bind' ||
              (input.operation === 'link' &&
                input.pullRequest !== undefined &&
                !isCurrentTaskPullRequest(record, intake, input.pullRequest)));
          if (bindingOnly && !operator) throw new Error('delivery-binding-operator-required');
          const receiptEffect =
            input.action === 'delivery' &&
            ['link', 'present', 'reconcile', 'compose', 'candidate', 'announce'].includes(
              input.operation,
            );
          const { source, message, progression } =
            bindingOnly || receiptEffect
              ? {
                  source:
                    nativeFeedback && !bindingOnly
                      ? { runId: caller.runId, inputEventId: nativeFeedback.inputId }
                      : await (
                          input.action === 'delivery' && receiptEffect && !bindingOnly
                            ? nativeInputEvent
                            : operatorInputEvent
                        )({
                          request,
                          senderIsOwner: operator,
                          sessionKey: caller.sessionKey,
                          sessionId: caller.sessionId,
                          runId: caller.runId,
                          inputId: caller.inputId,
                          retained: [],
                        }),
                  message: undefined,
                  progression: undefined,
                }
              : await verifyOpenClawWork({
                  record,
                  decision: input.action === 'implementation-context' ? input.decision : undefined,
                  save,
                  caller,
                  operator,
                  feedback: nativeFeedback
                    ? { inputId: nativeFeedback.inputId, message: nativeFeedback.event.source }
                    : undefined,
                  mode: issueWorkflowMode(
                    (await this.context.validateLocal(manifest, workspace, record, true)).manifest
                      .github?.notifications,
                    record,
                  ),
                  now,
                  request,
                  config: this.context.dependencies.config(),
                });
          await assertCurrent();
          if (input.action === 'implementation-context') {
            if (!record.request || !('key' in record.request))
              throw new Error('dispatch-work-context-mismatch');
            if (
              input.material &&
              (!record.work?.selection ||
                !record.progression ||
                record.progression.stage !== 'implementation')
            )
              throw new Error('implementation-material-context-required');
            const previous = record.work?.selection;
            const configured = (await this.context.validateLocal(manifest, workspace, record, true))
              .manifest.github?.notifications?.issueAssignment?.implementation;
            const selected = input.material
              ? previous!
              : (
                  await selectWorkflowStage({
                    stage: 'implementation',
                    configuration: {
                      ...configured,
                      ...record.manualIssue?.selections?.implementation,
                    },
                    workspace: current.workspace,
                    observedAt: previous?.observedAt ?? now,
                    resolveSkill: (id) =>
                      openClawSkill(
                        request,
                        record.request as { key: string; agentId: string },
                        id,
                      ),
                  })
                ).selection;
            // retain selection with the context that first enters implementation.
            const response = await openClawWorkAction({
              record,
              caller,
              source,
              progression: progression!,
              action: input,
              message,
              now,
              assertCurrent,
              save,
            });
            if (record.work) {
              record.work.selection ??= selected;
              if (!input.material) record.work.selection = selected;
              await save();
            }
            return {
              ...response,
              implementation: selected,
              currentIssue: { source: managedTargetUrl(intake) },
              initialReview: assessmentReviewContext(record, managedTargetUrl(intake)),
              ...(record.predecessorId
                ? {
                    predecessor: (() => {
                      const previous = tx.state.records.find((r) => r.id === record.predecessorId);
                      return {
                        id: record.predecessorId,
                        threadId: previous?.threadId,
                        worktree: previous?.worktree,
                        instruction:
                          'Preserved evidence is not current implementation or publication authority.',
                      };
                    })(),
                  }
                : {}),
            };
          }
          if (input.action !== 'delivery')
            return openClawWorkAction({
              record,
              caller,
              source,
              progression: progression!,
              action: input,
              message,
              now,
              assertCurrent,
              save,
            });
          const assertPRCheckout = async () => {
            if (
              !managedPullRequest(intake) ||
              !['prepare', 'publish', 'reconcile'].includes(input.operation)
            )
              return;
            const owned = await this.context.dependencies.worktrees.inspectGitHub(
              verified.worktreeInput,
            );
            if (!owned || owned.path !== record.worktree)
              throw new Error('delivery-worktree-owner-changed');
          };
          await assertPRCheckout();
          if (progression) record.progression = progression;
          return openClawDelivery({
            now,
            record,
            intake,
            action: input,
            operator,
            expectedLocalBranch: record.adoptedLocalBranch,
            source,
            base: managedPullRequest(intake)?.baseRef ?? repo.defaultBranch,
            recipients: issuePullRequestRecipients(
              current.policy.policy,
              Boolean(record.manualIssue),
            ),
            feedbackEnabled: openClawFeedbackEnabled(manifest),
            selectAnnouncement: async (retained) =>
              (
                await selectFeedbackStage({
                  policy: current.policy.policy,
                  workflow: 'issue-assignment',
                  workspace: current.workspace,
                  observedAt: retained?.composition?.observedAt ?? now,
                  retained: input.operation === 'compose' ? undefined : retained?.composition,
                  resolveSkill: (id) => {
                    if (!record.request || !('key' in record.request))
                      throw new Error('delivery-announcement-owner-required');
                    return openClawSkill(request, record.request, id);
                  },
                })
              ).selection,
            signal,
            assertCurrent,
            reauthorize: async () => {
              await this.context.validate(
                manifest,
                workspace,
                record,
                true,
                false,
                client,
                signal,
                !['compose', 'candidate', 'announce'].includes(input.operation),
              );
              await assertPRCheckout();
            },
            save,
            connect: async () => {
              if (!this.context.dependencies.delivery)
                throw new Error('delivery-runtime-unavailable');
              if (input.operation === 'bind') {
                const owned = await this.context.dependencies.worktrees.inspectGitHub(
                  verified.worktreeInput,
                );
                if (!owned || owned.path !== record.worktree)
                  throw new Error('delivery-worktree-diverged');
              }
              if (
                !managedPullRequest(intake) &&
                ['prepare', 'publish', 'reconcile'].includes(input.operation)
              )
                await new GitHubIdentityCache(current.store.location).resolve(
                  current.policy.policy,
                  client,
                  'delivery',
                );
              return this.context.dependencies.delivery({
                manifest,
                workspaceDir: current.workspace,
                worktree: record.worktree!,
                caller,
                signal,
                connection: client,
              });
            },
          }).catch((error: unknown) => {
            signal.throwIfAborted();
            const code = openClawDispatchFailureCode(error);
            return {
              status: dispatchFailureStatus({}, code, error),
              workflowStatus: record.delivery?.pullRequest
                ? workflowStatus(record)
                : dispatchFailureStatus({}, code, error),
              id: record.id,
              ...workflowFailure(error, code),
              code: code === 'dispatch-operation-failed' ? 'delivery-provider-failed' : code,
              pullRequest: record.delivery?.pullRequest,
              instructions: openClawDeliveryRecovery({
                operation: input.operation,
                code,
                announcement: record.announcement,
                delivery: record.delivery,
                linked: Boolean(taskPullRequest(record)),
                diagnostic: workflowFailure(error, code).providerDiagnostic,
              }),
            };
          });
        },
      );
    }
    if (input.action === 'context') {
      const signal = authority.signal
        ? AbortSignal.any([authority.signal, transactionSignal])
        : transactionSignal;
      const childAuthority = {
        signal,
        assertCurrent: async () => {
          signal.throwIfAborted();
          await authority.assertCurrent?.();
          await this.context.validateLocal(manifest, workspace, record, false);
          signal.throwIfAborted();
        },
      };
      await childAuthority.assertCurrent();
      return this.context.dependencies.credential.use(childAuthority, async (request) => {
        const selection =
          input.action === 'context' || !record.assessment
            ? await selectOpenClawAssessment({
                request,
                record,
                workspace: current.workspace,
                configuration: {
                  ...current.policy.policy.issueAssignment?.assessment,
                  ...record.manualIssue?.selections?.assessment,
                },
                now,
              })
            : undefined;
        const evidence =
          input.action === 'context' ? JSON.stringify({ source: source(intake) }) : undefined;
        await childAuthority.assertCurrent();
        const outcome = await issueAssessmentAction({
          selection,
          evidence,
          request,
          record,
          caller,
          intake,
          workspace: current.workspace,
          policy: manifest.github?.notifications,
          config: this.context.dependencies.config(),
          debug: manifest.debug,
          ...input,
          save,
          assertCurrent: childAuthority.assertCurrent,
        });
        return {
          ...outcome,
          ...(record.predecessorId
            ? {
                predecessor: (() => {
                  const previous = tx.state.records.find((r) => r.id === record.predecessorId);
                  return {
                    id: record.predecessorId,
                    threadId: previous?.threadId,
                    worktree: previous?.worktree,
                    instruction:
                      'Preserved evidence is not current implementation or publication authority.',
                  };
                })(),
              }
            : {}),
          assignmentObservation: record.assignmentObservation,
          assignmentWarning:
            record.assignmentObservation && workflowRecovery(record.assignmentObservation.code),
        };
      });
    }
    throw new Error('dispatch-action-invalid');
  }
  async present(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    action: Extract<Static<typeof dispatchParameters>, { action: 'delivery' }>,
    authority: DispatchAuthority,
    current: Pick<Awaited<ReturnType<OpenClawDispatchContext['scope']>>, 'admitted' | 'journal'>,
  ) {
    let stage: 'snapshot' | 'verification' = 'snapshot';
    let enteredJournal = false;
    const signal = authority.signal ?? new AbortController().signal;
    try {
      signal.throwIfAborted();
      const record = await current.journal.exclusive(async (state) => {
        enteredJournal = true;
        signal.throwIfAborted();
        const retained = state.records.find((entry) => entry.id === action.id);
        if (!retained) throw new Error('dispatch-receipt-missing');
        if (
          caller.sessionKey !== retained.threadId ||
          caller.sessionId !== retained.sessionCreation?.sessionId ||
          !nativeTurnFor(retained, 'assessment')
        )
          throw new Error('dispatch-assessment-caller-mismatch');
        return structuredClone(retained);
      }, false);
      stage = 'verification';
      const assertCurrent = async () => {
        signal.throwIfAborted();
        await authority.assertCurrent?.();
      };
      await assertCurrent();
      const intake = dispatchAdmission(record, current.admitted.records ?? []);
      if (!intake) throw new Error('dispatch-intake-record-missing');
      await this.context.dependencies.credential.use({ signal, assertCurrent }, async (request) => {
        await describeIssueSession(request, record, this.context.dependencies.config(), 'retained');
      });
      await assertCurrent();
      const result = presentOpenClawDelivery(record, intake, openClawFeedbackEnabled(manifest));
      return result;
    } catch (error) {
      signal.throwIfAborted();
      const code = openClawDispatchFailureCode(error);
      if (stage !== 'verification' && !enteredJournal && code === privateStateFileLockBusyErrorCode)
        return {
          status: 'busy' as const,
          id: action.id,
          ...workflowFailure(error, code),
          operation: 'present' as const,
          retryable: true,
          stage,
          instructions:
            'Retry delivery present in this issue chat to show the existing PR. Publication state is unchanged. Do not publish or create a replacement PR.',
        };
      return {
        status: 'blocked' as const,
        id: action.id,
        code: code === 'dispatch-operation-failed' ? 'delivery-provider-failed' : code,
        instructions:
          'Preserve the existing PR and receipt. After an interrupted presentation, retry delivery present in this issue chat; never create a replacement PR.',
      };
    }
  }
}
