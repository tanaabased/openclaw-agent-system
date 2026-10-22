import GitHubIdentityCache from '../channels/github/identity-cache.ts';
import continueOpenClawResponse, {
  openClawResponseEligible,
} from './openclaw-response-continuation.ts';
import openClawResponseAuthority from './openclaw-response-authority.ts';
import type { Static } from 'typebox';

import { type IntakeRecord } from '../channels/github/intake/record-store.ts';
import feedbackResponse from '../channels/github/presentation/feedback-response.ts';
import { privateStateFileLockBusyErrorCode } from '../core/private-state-file-lock.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import assessmentSummary from './assessment-summary.ts';
import { automationHash } from './automation-hash.ts';
import dispatchContext from './dispatch-context.ts';
import assessmentPresentation from './dispatch-presentation.ts';
import { dispatchFailurePhase, dispatchRetryDue, scheduleDispatchRetry } from './dispatch-retry.ts';
import redactFeedback from './feedback-redaction.ts';
import selectFeedbackStage from './feedback-stage.ts';
import issueProgression from './issue-progression.ts';
import { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { issueAssessmentAction, selectOpenClawAssessment } from './openclaw-assessment.ts';
import advanceOpenClawDecision, { openClawDecisionPending } from './openclaw-auto-decision.ts';
import advanceOpenClawWork from './openclaw-continuation.ts';
import openClawDelivery, { presentOpenClawDelivery } from './openclaw-delivery.ts';
import {
  type default as OpenClawDispatchContext,
  openClawDispatchFailureCode,
  type OpenClawDispatchTransaction,
  type OpenClawDispatchValidation,
} from './openclaw-dispatch-context.ts';

import { type OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { openClawFeedbackEnabled } from './openclaw-feedback-scan.ts';
import type { OpenClawFeedbackEvent } from './openclaw-feedback-state.ts';
import openClawFeedback, {
  advanceFeedbackTurn,
  authorizeFeedback,
  type OpenClawFeedbackAction,
} from './openclaw-feedback.ts';
import { describeIssueSession, type DispatchCaller } from './openclaw-session-create.ts';
import openClawSkill from './openclaw-skill.ts';
import openClawWorkAction, { verifyOpenClawWork } from './openclaw-work.ts';
import workflowFailure from './workflow-failure.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import workflowRecovery from './workflow-recovery.ts';

function source(intake: IntakeRecord) {
  return `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/issues/${intake.issue.number}`;
}
export default class OpenClawDispatchIssue {
  constructor(readonly context: OpenClawDispatchContext) {}
  async continueWork(
    manifest: AgentManifest,
    workspace: string,
    record: OpenClawDispatchRecord,
    save: () => Promise<void>,
    authority: DispatchAuthority,
    reconcileOnly = false,
  ) {
    if (openClawResponseEligible(record)) {
      try {
        await this.context.validate(manifest, workspace, record, true);
        return (
          (await this.context.dependencies.credential.use(authority, (request) =>
            continueOpenClawResponse({
              record,
              request,
              config: this.context.dependencies.config(),
              reconcileOnly,
              save,
              assertCurrent: async () => {
                await authority.assertCurrent?.();
                await this.context.validate(manifest, workspace, record, true);
              },
            }),
          )) ?? { status: 'assessment-pending' as const, id: record.id }
        );
      } catch (error) {
        const code = openClawDispatchFailureCode(error);
        if (record.summaryRecovery) record.summaryRecovery.code = code;
        await save();
        return { status: 'assessment-pending' as const, id: record.id, code, nextAction: 'next' };
      }
    }
    if (
      openClawDecisionPending(
        record,
        manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
      )
    ) {
      const assertDecision = async () => {
        await authority.assertCurrent?.();
        authority.signal?.throwIfAborted();
        const live = await this.context.validateLocal(manifest, workspace, record);
        if (
          !record.decisionTurn &&
          !openClawDecisionPending(
            record,
            live.manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
          )
        )
          throw new WorkflowPolicyHeld('workflow-mode-updated');
      };
      try {
        await this.context.validate(manifest, workspace, record);
        return await this.context
          .guardedCredential(async () => {
            await this.context.validate(manifest, workspace, record);
            await assertDecision();
          })
          .use({ ...authority, assertCurrent: assertDecision }, (request) =>
            advanceOpenClawDecision({
              record,
              request,
              config: this.context.dependencies.config(),
              save,
              assertCurrent: assertDecision,
            }),
          );
      } catch (error) {
        return {
          status: 'assessment-pending' as const,
          id: record.id,
          ...workflowFailure(error, openClawDispatchFailureCode(error)),
          nextAction: 'next',
        };
      }
    }
    const now = (this.context.dependencies.now ?? Date.now)();
    const assertCurrent = async () => {
      await authority.assertCurrent?.();
      authority.signal?.throwIfAborted();
      const live = await this.context.validateLocal(manifest, workspace, record, true);
      const transition = issueProgression(record, {
        mode: live.manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
        now,
      });
      if (transition.status !== 'ready') throw new WorkflowPolicyHeld(transition.reason);
    };
    try {
      await this.context.validate(manifest, workspace, record, true);
      const live = await this.context.validateLocal(manifest, workspace, record, true);
      return await this.context
        .guardedCredential(async () => {
          await this.context.validate(manifest, workspace, record, true);
          await assertCurrent();
        })
        .use({ ...authority, assertCurrent }, async (request) => {
          if (!record.request || !('key' in record.request))
            throw new Error('dispatch-work-context-mismatch');
          const selection =
            record.work?.selection ??
            (!record.work
              ? (
                  await selectWorkflowStage({
                    stage: 'implementation',
                    configuration:
                      live.manifest.github?.notifications?.issueAssignment?.implementation,
                    workspace,
                    observedAt: now,
                    resolveSkill: (id) =>
                      openClawSkill(
                        request,
                        record.request as { key: string; agentId: string },
                        id,
                      ),
                  })
                ).selection
              : undefined);
          return advanceOpenClawWork({
            record,
            reconcileOnly,
            mode: live.manifest.github?.notifications?.issueAssignment?.mode ?? 'auto',
            selection,
            now,
            request,
            config: this.context.dependencies.config(),
            save,
            assertCurrent,
          });
        });
    } catch (error) {
      if (error instanceof WorkflowPolicyHeld)
        return {
          status: 'policy-held' as const,
          id: record.id,
          reason: error.reason,
          nextAction: 'next',
        };
      const code = openClawDispatchFailureCode(error);
      if (
        record.work &&
        [
          'dispatch-turn-cancelled',
          'dispatch-turn-failed',
          'dispatch-turn-input-mismatch',
          'dispatch-turn-model-mismatch',
        ].includes(code)
      ) {
        record.work.code = code;
        await save();
      }
      return {
        status: 'implementation-pending' as const,
        id: record.id,
        ...workflowFailure(error, code),
        nextAction: 'next',
      };
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
    operator = false,
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
    try {
      const assertCurrent = async () => {
        authority.signal?.throwIfAborted();
        await authority.assertCurrent?.();
        await this.context.validateLocal(manifest, workspace, record, false, true);
      };
      await assertCurrent();
      const { intake, client } = await this.context.validate(
        manifest,
        workspace,
        record,
        false,
        true,
        undefined,
        authority.signal,
      );
      const provider = await this.context.dependencies.feedbackConnect?.(
        { manifest, workspaceDir: workspace },
        authority.signal ?? AbortSignal.timeout(60000),
        client,
      );
      if (!provider) throw new Error('feedback-provider-unavailable');
      return await this.context
        .guardedCredential(() =>
          this.context.validate(manifest, workspace, record, false, true, client, authority.signal),
        )
        .use({ ...authority, assertCurrent }, async (request) => {
          const common = {
            operator,
            record,
            event,
            caller,
            request,
            config: this.context.dependencies.config(),
            provider,
            policy: (await this.context.scope(manifest, workspace)).policy.policy,
            intake,
            workspace,
            now,
            debug: manifest.debug,
            signal: authority.signal,
            connectDelivery: async () => {
              if (!this.context.dependencies.delivery)
                throw new Error('delivery-runtime-unavailable');
              return this.context.dependencies.delivery({
                manifest,
                workspaceDir: workspace,
                worktree: record.worktree!,
                caller,
                signal: authority.signal ?? AbortSignal.timeout(60000),
                connection: client,
              });
            },
            assertCurrent,
            livePolicy: async () => {
              const live = await this.context.validateLocal(
                manifest,
                workspace,
                record,
                false,
                true,
              );
              return live.manifest.github!.notifications!;
            },
            reauthorize: async () => {
              await this.context.validate(
                manifest,
                workspace,
                record,
                false,
                true,
                client,
                authority.signal,
              );
            },
            save,
          };
          if (!action || action.operation === 'reconcile') {
            await authorizeFeedback(common);
            delete event.policyHeld;
            const result = await advanceFeedbackTurn(common);
            if (event.turn?.status === 'completed') {
              record.feedback!.lastServedAt = now;
              if (record.feedback!.activity) record.feedback!.activity.busy = false;
              await save();
            }
            if (!event.publicationAttempted || event.receipt) return result;
            return openClawFeedback({
              ...common,
              action: {
                action: 'feedback',
                operation: 'reconcile',
                id: record.id,
                eventId: event.id,
              },
            });
          }
          return openClawFeedback({ ...common, action });
        });
    } catch (error) {
      if (action?.resume)
        return {
          status: 'blocked' as const,
          id: record.id,
          eventId: event.id,
          code: openClawDispatchFailureCode(error),
        };
      if (error instanceof WorkflowPolicyHeld) {
        event.policyHeld = error.reason;
        await save();
        return {
          status: 'policy-held' as const,
          id: record.id,
          eventId: event.id,
          reason: error.reason,
          nextAction: 'next',
        };
      }
      const code = openClawDispatchFailureCode(error);
      if (event.phase !== 'published') {
        event.code = code;
        if (code === 'feedback-composition-changed' && !event.publicationAttempted && event.result)
          delete event.result.publicText;
        scheduleDispatchRetry(event, code, error, now);
      }
      // unknown transport outcomes retain custody; terminal failures release the queued work.
      if (
        event.phase !== 'published' &&
        !event.retry &&
        /revoked|authority-changed|owner-changed|source-(?:changed|identity-changed|author-changed|no-longer-eligible)|resource-missing|denied|turn-(?:failed|cancelled)|publication-(?:text|secret|output|reconciliation)|session-mismatch/.test(
          code,
        )
      ) {
        event.phase = 'blocked';
        record.feedback!.lastServedAt = now;
      }
      if (event.phase !== 'published' && dispatchFailurePhase(event, code, error) === 'blocked')
        event.phase = 'blocked';
      await save();
      return {
        status: event.phase === 'blocked' ? 'blocked' : dispatchFailurePhase(event, code, error),
        id: record.id,
        eventId: event.id,
        nextAction: code === 'feedback-composition-changed' ? 'compose' : 'next',
        code,
        ...(code === 'feedback-composition-changed'
          ? {
              next: 'Call feedback compose with this id and eventId, then create a new candidate using the selected skill and guidance. No new stage approval is needed; do not repeat an attempted publication.',
            }
          : {}),
        ...(event.result
          ? {
              presentation: feedbackResponse({
                privateText: event.result.privateText,
                selection: event.composition,
                workspace,
                debug: manifest.debug,
                publication: { withheld: code },
              }),
            }
          : {}),
      };
    }
  }

  async routeFeedback(
    input: Static<typeof dispatchParameters>,
    record: OpenClawDispatchRecord,
    tx: OpenClawDispatchTransaction,
    operator = false,
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
          caller.sessionId !== record.sessionCreation?.sessionId ||
          (caller.runId !== event.turn?.runId &&
            !(operator && input.operation === 'context' && input.resume)))
      )
        throw new Error('feedback-owner-caller-required');
      return this.feedback(
        manifest,
        current.workspace,
        record,
        event,
        caller,
        input,
        save,
        {
          ...authority,
          signal: authority.signal
            ? AbortSignal.any([authority.signal, transactionSignal])
            : transactionSignal,
        },
        operator,
      );
    }
    const feedbackSource = record.feedback?.events.find(
      (event) => event.turn?.runId === caller.runId,
    );
    if (feedbackSource) {
      return this.feedback(
        manifest,
        current.workspace,
        record,
        feedbackSource,
        caller,
        input.action === 'implementation-context' || input.action === 'implementation-result'
          ? {
              ...input,
              action: 'feedback',
              operation: input.action,
              eventId: feedbackSource.id,
            }
          : input.action === 'delivery'
            ? {
                ...input,
                action: 'feedback',
                operation: 'delivery',
                deliveryOperation: input.operation,
                eventId: feedbackSource.id,
              }
            : {
                action: 'feedback',
                id: record.id,
                eventId: feedbackSource.id,
                operation: 'context',
              },
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
    const {
      manifest,
      workspace,
      caller,
      authority,
      current,
      save,
      transactionSignal,
      sourceThreadId,
      now,
    } = tx;
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
      const assertCurrent = async () => {
        signal.throwIfAborted();
        await authority.assertCurrent?.();
        await this.context.validateLocal(manifest, workspace, record, true);
        signal.throwIfAborted();
      };
      return this.context.dependencies.credential.use(
        { signal, assertCurrent },
        async (request) => {
          const { source, message, progression } = await verifyOpenClawWork({
            record,
            caller,
            operator,
            mode:
              (await this.context.validateLocal(manifest, workspace, record, true)).manifest.github
                ?.notifications?.issueAssignment?.mode ?? 'auto',
            now,
            request,
            config: this.context.dependencies.config(),
          });
          await assertCurrent();
          if (
            input.action === 'implementation-context' &&
            record.work?.result?.outcome !== 'done'
          ) {
            if (!record.request || !('key' in record.request))
              throw new Error('dispatch-work-context-mismatch');
            const previous = record.work?.selection;
            const configured = (await this.context.validateLocal(manifest, workspace, record, true))
              .manifest.github?.notifications?.issueAssignment?.implementation;
            const selected = (
              await selectWorkflowStage({
                stage: 'implementation',
                configuration: configured,
                workspace: current.workspace,
                observedAt: previous?.observedAt ?? now,
                resolveSkill: (id) =>
                  openClawSkill(request, record.request as { key: string; agentId: string }, id),
              })
            ).selection;
            // retain selection with the context that first enters implementation.
            const response = await openClawWorkAction({
              record,
              caller,
              source,
              progression,
              action: input,
              message,
              now,
              assertCurrent,
              save,
            });
            if (record.work) {
              record.work.selection ??= selected;
              await save();
            }
            return {
              ...response,
              implementation: selected,
            };
          }
          if (input.action !== 'delivery')
            return openClawWorkAction({
              record,
              caller,
              source,
              progression,
              action: input,
              now,
              assertCurrent,
              save,
            });
          return openClawDelivery({
            record,
            intake,
            action: input,
            source,
            base: repo.defaultBranch,
            recipients: current.policy.policy.issueAssignment?.pullRequest?.recipients,
            feedbackEnabled: openClawFeedbackEnabled(manifest),
            selectAnnouncement: async (retained) =>
              (
                await selectFeedbackStage({
                  policy: current.policy.policy,
                  workflow: 'issue-assignment',
                  workspace: current.workspace,
                  observedAt: retained?.composition.observedAt ?? now,
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
              await this.context.validate(manifest, workspace, record, true, false, client, signal);
            },
            save,
            connect: async () => {
              if (!this.context.dependencies.delivery)
                throw new Error('delivery-runtime-unavailable');
              if (['prepare', 'publish', 'reconcile'].includes(input.operation))
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
              status: dispatchFailurePhase({}, code, error),
              workflowStatus: record.work?.delivery?.pullRequest
                ? 'partially-delivered'
                : dispatchFailurePhase({}, code, error),
              id: record.id,
              ...workflowFailure(error, code),
              code: code === 'dispatch-operation-failed' ? 'delivery-provider-failed' : code,
              pullRequest: record.work?.delivery?.pullRequest,
              instructions:
                'Preserve this operation and all work. Stop on denial or lost authority. For an interrupted publication, use delivery prepare again in this issue chat to reconcile the existing attempt. Never create a replacement PR or discard its retained binding.',
            };
          });
        },
      );
    }
    if (input.action === 'context' || input.action === 'result' || input.action === 'summary') {
      const signal = authority.signal
        ? AbortSignal.any([authority.signal, transactionSignal])
        : transactionSignal;
      const childAuthority = {
        signal,
        assertCurrent: async () => {
          signal.throwIfAborted();
          await authority.assertCurrent?.();
          await this.context.validateLocal(manifest, workspace, record, input.action === 'summary');
          signal.throwIfAborted();
        },
      };
      await childAuthority.assertCurrent();
      return this.context.dependencies.credential.use(childAuthority, async (request) => {
        if (input.action === 'summary') {
          if (!record.result || !record.request || !('key' in record.request))
            throw new Error('assessment-summary-assessment-turn-required');
          const expected = record.request;
          const recovery = record.resultTurnId !== caller.runId;
          if (recovery || record.assessmentCaller?.runId !== caller.runId)
            await openClawResponseAuthority({
              request,
              record,
              caller,
              config: this.context.dependencies.config(),
              observeOnly: input.operation === 'reconcile',
            });
          return assessmentSummary({
            recovery,
            record,
            intake,
            action: input,
            turnId: caller.runId,
            authorityDigest: automationHash({
              sourceThreadId,
              manifest: current.manifestDigest,
            }),
            presentation: assessmentPresentation(record.result, record, intake, current.workspace, {
              debug: manifest.debug,
            }),
            save,
            redact: redactFeedback,
            authorize: async () => {
              await childAuthority.assertCurrent();
              await this.context.validate(
                manifest,
                workspace,
                record,
                true,
                false,
                undefined,
                signal,
              );
            },
            select: async (previous) =>
              (
                await selectFeedbackStage({
                  policy: current.policy.policy,
                  workflow: 'issue-assignment',
                  workspace: current.workspace,
                  observedAt: previous?.observedAt ?? now,
                  resolveSkill: (id) => openClawSkill(request, expected, id),
                })
              ).selection,
            connect: async () => {
              const provider = await this.context.dependencies.feedbackConnect?.(
                { manifest, workspaceDir: current.workspace },
                signal,
                client,
              );
              if (!provider) throw new Error('assessment-summary-provider-unavailable');
              return { client: provider, authorLogin: provider.identity.login };
            },
          });
        }
        const selection =
          record.resultTurnId === caller.runId && record.turnEvidence?.selection
            ? record.turnEvidence.selection
            : input.action === 'context' || !record.assessment
              ? await selectOpenClawAssessment({
                  request,
                  record,
                  workspace: current.workspace,
                  configuration: current.policy.policy.issueAssignment?.assessment,
                  now,
                })
              : undefined;
        const evidence =
          input.action === 'context'
            ? JSON.stringify(
                dispatchContext(
                  await client.getItemContext(
                    repo.owner.login,
                    repo.name,
                    intake.issue.number,
                    'issue',
                    true,
                  ),
                  source(intake),
                  now,
                ),
              )
            : undefined;
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
    action: Extract<Static<typeof dispatchParameters>, { action: 'delivery' | 'present' }>,
    authority: DispatchAuthority,
    current: Pick<Awaited<ReturnType<OpenClawDispatchContext['scope']>>, 'admitted' | 'journal'>,
  ) {
    let stage: 'snapshot' | 'verification' | 'commit' = 'snapshot';
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
          !retained.assessmentTurn
        )
          throw new Error('dispatch-assessment-caller-mismatch');
        return structuredClone(retained);
      });
      const snapshot = automationHash(record);
      stage = 'verification';
      const assertCurrent = async () => {
        signal.throwIfAborted();
        await authority.assertCurrent?.();
      };
      await assertCurrent();
      const intake = current.admitted.records.find((entry) => entry.id === record.intakeId);
      if (!intake) throw new Error('dispatch-intake-record-missing');
      await this.context.dependencies.credential.use({ signal, assertCurrent }, async (request) => {
        await describeIssueSession(request, record, this.context.dependencies.config(), true);
      });
      await assertCurrent();
      const result =
        action.action === 'present'
          ? (() => {
              if (!record.result) throw new Error('dispatch-result-missing');
              return {
                status: 'presented' as const,
                retained: true,
                id: record.id,
                presentation: assessmentPresentation(record.result, record, intake, workspace, {
                  debug: manifest.debug,
                  includeDetails: action.includeDetails,
                }),
                instructions:
                  'Show this complete saved assessment. This read does not authorize assessment, implementation, or publication.',
              };
            })()
          : presentOpenClawDelivery(record, intake, openClawFeedbackEnabled(manifest));
      if (action.action === 'present') return result;
      stage = 'commit';
      enteredJournal = false;
      return await current.journal.exclusive(async (state, save, lockSignal) => {
        enteredJournal = true;
        signal.throwIfAborted();
        lockSignal.throwIfAborted();
        await authority.assertCurrent?.();
        const retained = state.records.find((entry) => entry.id === action.id);
        if (!retained || automationHash(retained) !== snapshot)
          throw new Error('delivery-presentation-state-changed');
        retained.work!.delivery!.presentation = record.work!.delivery!.presentation;
        signal.throwIfAborted();
        await save();
        return result;
      });
    } catch (error) {
      signal.throwIfAborted();
      const code = openClawDispatchFailureCode(error);
      if (stage !== 'verification' && !enteredJournal && code === privateStateFileLockBusyErrorCode)
        return {
          status: 'busy' as const,
          id: action.id,
          code,
          operation: 'present' as const,
          retryable: true,
          stage,
          instructions:
            action.action === 'present'
              ? 'Retry present in this issue chat to show the saved assessment. This read grants no workflow authority.'
              : 'Retry delivery present in this issue chat to show the existing PR. Publication state is unchanged. Do not publish or create a replacement PR.',
        };
      return {
        status: 'blocked' as const,
        id: action.id,
        code: code === 'dispatch-operation-failed' ? 'delivery-provider-failed' : code,
        instructions:
          action.action === 'present'
            ? 'Preserve the saved assessment. Retry present in its owning issue chat after resolving this read failure.'
            : 'Preserve the existing PR and receipt. After an interrupted presentation, retry delivery present in this issue chat; never create a replacement PR.',
      };
    }
  }
}
