import OpenClawDispatchContext, {
  type OpenClawDispatchDependencies,
} from '../dispatch/openclaw-dispatch-context.ts';
import reconcileOpenClawLifecycle from '../dispatch/openclaw-assignment-lifecycle.ts';
import assignmentRetirement from '../retirement/assignment-retirement.ts';
import { operatorInputEvent } from '../../openclaw-session-input.ts';
import workflowFailure from '../workflow-failure.ts';
import { parseReviewRequest } from '../../../tools/dispatch/review-schema.ts';
import GitHubWorkEventClient from '../../../channels/github/provider/work-event-client.ts';
import type { AgentManifest } from '../../../manifest/types.ts';
import type { DispatchAuthority } from '../../../credentials/session-dispatch.ts';
import createIssueSession, {
  describeIssueSession,
  type DispatchCaller,
} from '../../openclaw-session-create.ts';
import { openClawSkillResolver } from '../../openclaw-skill.ts';
import { automationHash } from '../../automation-hash.ts';
import type { OpenClawTurn } from '../../openclaw-turn-state.ts';
import { selectOpenClawTaskContext } from '../context/openclaw-task-context.ts';
import reviewPolicy from './review-policy.ts';
import reviewContext, { reviewerInstructions, reviewTarget } from './review-context.ts';
import { scanReviewFeedback } from './openclaw-review-feedback.ts';
import { advanceFeedbackTurn } from '../feedback/openclaw-feedback.ts';
import authorizeFeedback from '../feedback/feedback-source-context.ts';
import feedbackPresentation from '../feedback/feedback-presentation.ts';
import publishOwnedReview from './publish-owned-review.ts';
import discoverReviews from './discover-reviews.ts';
import { admitReview, reviewKey, type ReviewAdmission } from './review-admission.ts';
import observeReview from './review-observation.ts';
import reviewModelRouting, { reviewRoutingGuidance } from '../../models/review-model-routing.ts';
import routingInstructions, {
  assertRoutingInstructions,
  routingInstructionsReference,
  routingInstructionsGuidance,
} from '../../models/routing-instructions.ts';
import { modelRoutingRubric } from '../../models/model-routing.ts';
import { selectAssignmentClaim, acceptAssignmentClaim } from '../dispatch/assignment-claim.ts';
import reviewClaimSource from './review-claim-source.ts';
import repositoryScope from '../../../channels/github/repository-scope.ts';
import openClawCapacity from '../dispatch/openclaw-capacity.ts';
import managedGroupName from '../../../utils/managed-group-name.ts';
import observeIssueActivity from '../../openclaw-session-activity.ts';
import deliverOpenClawTaskInput from '../context/openclaw-task-input.ts';
import { assertNotificationManagement } from '../../notification-reset-state.ts';

export default async function openClawReview(
  deps: OpenClawDispatchDependencies,
  manifest: AgentManifest,
  workspace: string,
  caller: DispatchCaller,
  raw: Record<string, unknown>,
  operator: boolean,
  authority: DispatchAuthority,
) {
  const input = parseReviewRequest(raw);
  const current = await selectOpenClawTaskContext(deps.taskContext, manifest, workspace, {
    resolvePolicy: false,
  });
  const selected = reviewPolicy(manifest, 'openclaw', true);
  if (!selected) throw new Error('review-runtime-disabled');
  const { policy } = selected;
  const journal = current.dispatch(deps.root);
  await assertNotificationManagement(deps.root, journal.scope, current.store.agentStorage);
  const operatorInput =
    operator &&
    ['launch', 'retire', 'next', 'prepare', 'reconcile'].includes(input.operation) &&
    !caller.jobId &&
    (input.operation !== 'reconcile' || !!input.target)
      ? await deps.credential.use(authority, (request) =>
          operatorInputEvent({ ...caller, request, senderIsOwner: operator, retained: [] }),
        )
      : undefined;
  const coordinator = Boolean(
    caller.jobId &&
    policy.reviewRequest &&
    !policy.reviewRequest.paused &&
    (await deps.reviewOccurrence?.(manifest, workspace, caller, authority)),
  );
  if (input.operation === 'retire' || (input.operation === 'next' && coordinator)) {
    let targetId: string | undefined;
    if (input.operation === 'retire') {
      if (!operatorInput || !input.target) throw new Error('review-operator-target-required');
      targetId = await journal.exclusive(async (state, save) => {
        const found = state.records.filter(
          (r) =>
            r.reviewAdmission && !r.supersededBy && !r.reset && reviewTarget(r) === input.target,
        );
        if (found.length !== 1) throw new Error('review-target-unavailable');
        const record = found[0]!;
        const now = Date.now();
        record.retirement = assignmentRetirement({
          previous: record.retirement,
          reason: 'operator-requested',
          intakeId: record.id,
          now,
          graceMinutes: 0,
          operatorRequest: {
            at: now,
            targetId: record.id,
            caller: caller.sessionKey,
            turnId: caller.runId,
            inputId: operatorInput.inputEventId,
          },
        });
        await authority.assertCurrent?.();
        await save();
        return record.id;
      });
    }
    const result = await reconcileOpenClawLifecycle({
      service: new OpenClawDispatchContext(deps),
      manifest,
      workspace,
      authority,
      reviewOwner: caller.sessionKey,
      activeSessionKey: caller.sessionKey,
      targetId,
    });
    if (targetId) return result ?? { status: 'retirement-pending', target: input.target };
  }
  return journal.exclusive(async (state, save, signal) => {
    const active = state.records.filter(
      (r) => r.reviewAdmission && !r.reset && !r.retirement && !r.supersededBy,
    );
    const owned = active.find(
      (r) =>
        r.threadId === caller.sessionKey &&
        r.sessionCreation?.verified &&
        r.sessionCreation.sessionId === caller.sessionId,
    );
    const target = input.target;
    const candidates = target ? active.filter((r) => reviewTarget(r) === target) : active;
    const manual = !!operatorInput;
    if (!owned && !coordinator && !manual) throw new Error('review-native-caller-required');
    const client = await deps.connect({ manifest, workspaceDir: workspace }, signal);
    if (!(client instanceof GitHubWorkEventClient))
      throw new Error('review-provider-binding-required');
    if (client.identity.login.toLowerCase() !== selected.username.toLowerCase())
      throw new Error('review-account-mismatch');
    await current.store.identities.resolve(policy, client, 'review');
    await current.store.identities.hydrate(policy);
    const manifestDigest = automationHash([
      reviewPolicy(manifest, 'openclaw', true)!.digest,
      manifest.models,
    ]);
    const fresh = async () => {
      signal.throwIfAborted();
      await authority.assertCurrent?.();
      const loaded = await deps.taskContext.manifestService.loadForAgentId(
        manifest.agent.id,
        'service',
      );
      if (
        loaded.status !== 'loaded' ||
        loaded.scope.workspaceDir !== workspace ||
        loaded.manifest.github?.username !== selected.username
      )
        throw new Error('review-policy-changed');
      await current.store.identities.hydrate(loaded.manifest.github?.notifications);
      const live = reviewPolicy(loaded.manifest, 'openclaw', true);
      if (
        !live ||
        automationHash([live.digest, loaded.manifest.models]) !== manifestDigest ||
        (coordinator && live.policy.reviewRequest?.paused)
      )
        throw new Error('review-policy-changed');
    };
    const binding = {
      scope: journal.scope,
      workspaceDir: current.workspace,
      agentId: manifest.agent.id,
    };
    const now = Date.now();
    const retain = async (admission: ReviewAdmission) => {
      const previous = active.find((r) => r.issueKey === reviewKey(admission));
      if (previous?.request || state.records.some((r) => r.id === admission.id)) return;
      if (previous) previous.supersededBy = admission.id;
      const record = {
        id: admission.id,
        reviewAdmission: admission,
        issueKey: reviewKey(admission),
        sourceThreadId: caller.sessionKey,
        createdAt: now,
        manifestDigest,
      };
      state.records.push(record);
      active.push(record);
      await fresh();
      await save();
    };
    if (owned) {
      if (target || !['context', 'publish', 'reconcile'].includes(input.operation))
        throw new Error('review-owner-selectors-forbidden');
      await deps.credential.use(authority, async (request) => {
        await describeIssueSession(request, owned, deps.config());
      });
      if (input.operation === 'context')
        return deps.credential.use(authority, (request) =>
          reviewContext({
            record: owned,
            manifest,
            workspace,
            resolveSkill: openClawSkillResolver(request, {
              agentId: manifest.agent.id,
              key: caller.sessionKey,
            }),
          }),
        );
      return publishOwnedReview(owned, input, caller.runId, client, policy, fresh, save);
    }
    if (input.operation === 'launch') {
      const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)$/u.exec(
        target ?? '',
      );
      if (!manual || !match) throw new Error('review-operator-target-required');
      const repository = await client.getRepository(match[1]!, match[2]!);
      const item = await client.getItem(match[1]!, match[2]!, Number(match[3]));
      const admission = admitReview({
        ...binding,
        repository,
        item,
        policy,
        identity: client.identity,
        now,
        operator: {
          kind: 'operator',
          session: caller.sessionKey,
          turn: caller.runId,
          input: operatorInput!.inputEventId,
        },
      });
      if (input.overrides) admission.selections = input.overrides;
      if (!candidates.length) await retain(admission);
      return { status: 'admitted', target, instruction: 'Call review next with this target.' };
    }
    if (input.operation === 'scan') {
      if (!coordinator || !policy.reviewRequest || policy.reviewRequest.paused)
        throw new Error('review-coordinator-required');
      const obstacles = await discoverReviews(client, policy, binding, now, signal, retain);
      return { status: 'observed', obstacles };
    }
    if (!['next', 'prepare', 'reconcile'].includes(input.operation))
      throw new Error('review-operation-unavailable');
    if (
      !coordinator &&
      (!manual ||
        !target ||
        !candidates.every(
          (r) =>
            r.sourceThreadId === caller.sessionKey && r.reviewAdmission!.origin.kind === 'operator',
        ))
    )
      throw new Error('review-coordinator-required');
    const obstacles: Array<{ target: string; code: string }> = [];
    for (const record of candidates) {
      try {
        const admission = record.reviewAdmission!;
        const url = reviewTarget(record);
        const observed = await observeReview(
          admission,
          client,
          policy,
          !!record.sessionCreation?.verified,
        );
        if (observed.status !== 'ready') {
          if (target) return { status: observed.status, target: url };
          continue;
        }
        if (record.sessionCreation?.verified) {
          await current.store.identities.resolve(policy, client, 'review-feedback', true);
          const event = await scanReviewFeedback(record, deps, client, policy);
          if (record.feedback) await save();
          if (event && record.reviewObservation === observed.fingerprint) {
            const authorizeInput = async () => {
              await authorizeFeedback({
                conversation: true,
                record,
                event,
                intake: admission,
                policy,
                provider: client,
                assertCurrent: fresh,
              });
            };
            await authorizeInput();
            return deps.credential.use(authority, (request) =>
              advanceFeedbackTurn({
                record,
                event,
                request,
                config: deps.config(),
                save,
                assertCurrent: fresh,
                authorizeInput,
                sourcePresentation:
                  feedbackPresentation(
                    event,
                    admission.repository.owner.login + '/' + admission.repository.name,
                  ) +
                  '\n\nReview feedback. Respond through the source-bound reply composer. Keep fixes with the author.',
              }),
            );
          }
        }
        const fingerprint = observed.fingerprint!;
        if (
          record.sessionCreation?.verified &&
          record.reviewObservation === fingerprint &&
          !record.nativeTurns?.some((e) => e.role === 'review')
        ) {
          if (target) return { status: 'unchanged', target: url };
          continue;
        }
        if (!record.request) {
          if (admission.origin.kind === 'request') {
            if (
              openClawCapacity(state, policy.maxConcurrentItems, state.issuePickup).available < 1
            ) {
              if (target) return { status: 'at-capacity', target };
              continue;
            }
            if (!deps.claims) throw new Error('review-claim-store-required');
            const route = repositoryScope(policy, observed.repository, 'review-request');
            const decision = await selectAssignmentClaim({
              store: deps.claims.store,
              client: deps.claims.connect(client),
              source: reviewClaimSource(admission),
              passId: automationHash([caller.sessionKey, caller.runId]),
              mode: route.decision,
              eligibleInstanceIds: route.eligibleInstanceIds,
              hasCapacity:
                openClawCapacity(state, policy.maxConcurrentItems, state.issuePickup).available > 0,
            });
            if (!['local', 'owned'].includes(decision.status)) {
              if (target) return { ...decision, target: url };
              continue;
            }
            record.claimId = decision.winnerId;
          }
          const instructions = await routingInstructions({
            configuration: manifest.models?.routing,
            workspace,
            observedAt: now,
            resolveSkill: (id) =>
              deps.credential.use(authority, (request) =>
                openClawSkillResolver(request, {
                  agentId: manifest.agent.id,
                  key: caller.sessionKey,
                })(id),
              ),
          });
          if (input.operation !== 'prepare') {
            record.routingInstructions = instructions;
            record.context = JSON.stringify(
              await client.getReviewRoutingContext(
                admission.repository.owner.login,
                admission.repository.name,
                admission.issue.number,
              ),
            );
            admission.head = observed.ci.head;
            record.manifestDigest = manifestDigest;
            await save();
            return {
              status: 'routing-required',
              target: url,
              context: JSON.parse(record.context),
              guidance: reviewRoutingGuidance,
              rubric: modelRoutingRubric,
              instructions: routingInstructionsGuidance,
              routingInstructions: routingInstructionsReference(instructions),
            };
          }
          if (
            !target ||
            !record.context ||
            admission.head !== observed.ci.head ||
            manifestDigest !== record.manifestDigest
          )
            throw new Error('review-preparation-stale');
          assertRoutingInstructions(instructions, record.routingInstructions);
          if (input.overrides && !manual) throw new Error('review-operator-selection-required');
          const routing = reviewModelRouting({
            models: manifest.models,
            manifestDigest,
            runtime: 'openclaw',
            context: JSON.parse(record.context),
            assessment: input.assessment,
            overrides: input.overrides ?? admission.selections,
          });
          if (!('candidate' in routing)) throw new Error(routing.code);
          record.routing = JSON.stringify(routing);
          record.request = {
            key: 'agent:' + manifest.agent.id + ':dashboard:agent-system-review-' + record.id,
            idempotencyKey: record.id,
            agentId: manifest.agent.id,
            label: input.title ?? 'Review ' + url,
            category: managedGroupName(admission.repository.name, 512),
            cwd: current.workspace,
            model: routing.candidate.model,
            thinkingLevel: routing.candidate.thinking,
          };
          record.sessionCreation = {
            attempted: false,
            sourceSessionId: caller.sessionId,
            sourceRunId: caller.runId,
            sourceToolCallId: caller.toolCallId,
          };
          await fresh();
          await save();
        }
        const assertEvidence = async () => {
          await fresh();
          const live = await observeReview(
            admission,
            client,
            policy,
            !!record.sessionCreation?.verified,
          );
          if (live.status !== 'ready' || live.fingerprint !== observed.fingerprint)
            throw new Error('review-evidence-changed');
        };
        if (!record.sessionCreation?.verified)
          await createIssueSession({
            record,
            save,
            credential: new OpenClawDispatchContext(deps).guardedCredential(assertEvidence),
            authority,
            config: deps.config(),
          });
        if (record.claimId && !record.claimAccepted && deps.claims) {
          await acceptAssignmentClaim({
            store: deps.claims.store,
            client: deps.claims.connect(client),
            source: reviewClaimSource(admission),
            nativeReceipt: record.sessionCreation!.sessionId!,
          });
          record.claimAccepted = true;
          await save();
        }
        const delivery = await deps.credential.use(authority, async (request) => {
          const session = await observeIssueActivity(request, record, deps.config());
          const existing = record.nativeTurns?.find((e) => e.role === 'review')?.turn;
          if (session.busy && !existing) return { status: 'busy', target: url };
          const receipt = await deliverOpenClawTaskInput({
            record,
            turn: existing as OpenClawTurn | undefined,
            source: 'feedback',
            request,
            config: deps.config(),
            save,
            assertCurrent: assertEvidence,
            prepare: async () => ({
              runId: automationHash([record.id, fingerprint, caller.runId]),
              leaf: typeof session.leaf === 'string' ? session.leaf : null,
              message:
                reviewerInstructions +
                '\n\nReview ' +
                url +
                ' at ' +
                observed.ci.head +
                '. Call dispatch review context for your configured review skill.',
            }),
            retain: (turn) => {
              record.nativeTurns = [{ role: 'review', turn }];
              admission.head = observed.ci.head;
              admission.baseRef = observed.item.pullRequest!.baseRef;
              record.reviewObservation = fingerprint;
            },
          });
          if (receipt.status === 'delivered') {
            record.nativeTurns = record.nativeTurns?.filter((e) => e.role !== 'review');
            await save();
          }
          return { status: receipt.status, target: url };
        });
        if (!target && ['pending', 'busy'].includes(delivery.status)) continue;
        return delivery;
      } catch (error) {
        signal.throwIfAborted();
        if (target) throw error;
        obstacles.push({
          target: reviewTarget(record),
          code: workflowFailure(error, 'review-operation-failed').code,
        });
      }
    }
    return obstacles.length ? { status: 'obstacles', obstacles } : { status: 'unchanged' };
  });
}
