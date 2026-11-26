import { parseReviewRequest } from '../../../tools/dispatch/review-schema.ts';
import GitHubWorkEventClient from '../../../channels/github/provider/work-event-client.ts';
import discoverReviews from './discover-reviews.ts';
import repositoryScope from '../../../channels/github/repository-scope.ts';
import GitHubAssignmentClaimClient from '../../../channels/github/provider/assignment-claim-client.ts';
import publishOwnedReview from './publish-owned-review.ts';
import connectCodexGitHubAccount from '../../codex-github-client.ts';
import { connectCodexThreads } from '../../codex-thread-client.ts';
import {
  selectCodexTaskContext,
  type CodexTaskContextDependencies,
} from '../context/codex-task-context.ts';
import { selectCodexTaskOwner } from '../context/codex-turn-task.ts';
import { codexDispatchNative } from '../dispatch/codex-dispatch-native.ts';
import { verifyDispatchWorktree, type DispatchGit } from '../dispatch/codex-dispatch-project.ts';
import { codexNativeHandoff } from '../dispatch/codex-dispatch-handoff.ts';
import { codexInstanceStore } from '../dispatch/codex-assignment-claims.ts';
import {
  selectAssignmentClaim,
  acceptAssignmentClaim,
  type ClaimClient,
} from '../dispatch/assignment-claim.ts';
import codexCapacity from '../dispatch/codex-capacity.ts';
import { inspectCodexReviewActivation } from '../../automations/codex-automation-activation.ts';
import acceptCodexIntakeOccurrence from '../../codex-intake-occurrence.ts';
import { automationHash } from '../../automation-hash.ts';
import reviewModelRouting, { reviewRoutingGuidance } from '../../models/review-model-routing.ts';
import { modelRoutingRubric } from '../../models/model-routing.ts';
import routingInstructions, {
  assertRoutingInstructions,
  routingInstructionsGuidance,
  routingInstructionsReference,
} from '../../models/routing-instructions.ts';
import { admitReview, reviewKey } from './review-admission.ts';
import observeReview from './review-observation.ts';
import reviewClaimSource from './review-claim-source.ts';
import workflowFailure from '../workflow-failure.ts';
import reviewContext, { reviewerInstructions, reviewTarget } from './review-context.ts';
import retireCodexReviews from './codex-review-retirement.ts';
import codexRetirementNative from '../retirement/codex-retirement-native.ts';
import {
  codexCleanupConfiguration,
  type CleanupConfiguration,
} from '../../cleanup-configuration.ts';
import { resolve } from 'node:path';
import codexContinuationNative from '../implementation/codex-continuation-native.ts';
import deliverTaskInput from '../context/task-input-delivery.ts';
import assignmentRetirement from '../retirement/assignment-retirement.ts';
import reconcileRetirementEffects from '../retirement/reconcile-retirement-effects.ts';
import codexSessionSettings from '../../models/codex-session-settings.ts';

type ReviewClient = Pick<
  GitHubWorkEventClient,
  | 'identity'
  | 'resolveIdentity'
  | 'resolveIdentities'
  | 'getItem'
  | 'getRepository'
  | 'discoverAssigned'
  | 'listAssignmentEvents'
  | 'discoverReviewRequests'
  | 'getReviewCI'
  | 'getReviewRoutingContext'
> & {
  reviewRequests: Pick<GitHubWorkEventClient['reviewRequests'], 'current' | 'latest'>;
  reviews: Pick<GitHubWorkEventClient['reviews'], 'getReviewComments' | 'listReviews' | 'submit'>;
};
export interface CodexReviewDependencies extends CodexTaskContextDependencies {
  threadId?: string;
  native?: ReturnType<typeof codexDispatchNative>;
  connect?: (workspace: string, signal: AbortSignal) => Promise<ReviewClient>;
  claimClient?: ClaimClient;
  activation?: typeof inspectCodexReviewActivation;
  git?: DispatchGit;
  readCleanupConfiguration?: () => Promise<CleanupConfiguration>;
  retirementNative?: ReturnType<typeof codexRetirementNative>;
  continuationNative?: ReturnType<typeof codexContinuationNative>;
}

/** review-specific admission composes the existing native dispatch and effect owners. */
export default async function codexReview(
  pluginData: string,
  raw: Record<string, unknown>,
  deps: CodexReviewDependencies = {},
) {
  const authored = { ...raw };
  delete authored.projects;
  delete authored.threads;
  const input = parseReviewRequest(authored);
  if (input.operation === 'check') throw new Error('review-condition-openclaw-only');
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('review-native-caller-required');
  const current = await selectCodexTaskContext(pluginData, deps, { resolvePolicy: false });
  const policy = current.manifest.github?.notifications;
  if (!policy || !policy.runtimes.includes('codex')) throw new Error('review-runtime-disabled');
  const journal = current.journal;
  const connection = deps.native
    ? undefined
    : await connectCodexThreads(current.workspace, current.codexHome);
  const native = deps.native ?? codexDispatchNative(connection!.request);
  try {
    return await journal.exclusive(async (state, save, signal) => {
      const now = Date.now();
      const selected = input.target
        ? state.records.filter(
            (record) =>
              record.reviewAdmission &&
              reviewTarget(record) === input.target &&
              !record.reset &&
              !record.supersededBy,
          )
        : [];
      if (selected.length > 1) throw new Error('review-target-ambiguous');
      const currentOwner =
        ['context', 'publish', 'reconcile'].includes(input.operation) && !input.target
          ? await selectCodexTaskOwner(state.records, caller, native.find)
          : undefined;
      if (currentOwner && !currentOwner.record.reviewAdmission)
        throw new Error('review-native-owner-required');
      const record = currentOwner?.record ?? selected[0];
      const operator =
        ['launch', 'retire'].includes(input.operation) ||
        (record?.reviewAdmission?.origin.kind === 'operator' && record.sourceThreadId === caller);
      let turnId: string;
      let operatorInput: Awaited<ReturnType<typeof native.operatorInput>> | undefined;
      if (currentOwner) turnId = currentOwner.native.turnId!;
      else if (operator) {
        operatorInput = await native.operatorInput(caller);
        turnId = operatorInput.turnId;
      } else {
        const occurrence = await native.occurrence(caller);
        const activation = await (deps.activation ?? inspectCodexReviewActivation)(
          pluginData,
          deps,
          state.run?.id === occurrence.id,
        );
        if (activation.threadId !== caller || activation.nativeId !== occurrence.automationId)
          throw new Error('review-native-occurrence-mismatch');
        await acceptCodexIntakeOccurrence(state, occurrence, async () => activation, save);
        turnId = occurrence.id;
      }
      const client = deps.connect
        ? await deps.connect(current.workspace, signal)
        : new GitHubWorkEventClient(
            (await connectCodexGitHubAccount(current.workspace, signal)).account,
          );
      const claimClient = () => {
        if (deps.claimClient) return deps.claimClient;
        if (!(client instanceof GitHubWorkEventClient))
          throw new Error('review-provider-binding-required');
        return new GitHubAssignmentClaimClient(client);
      };
      if (
        typeof current.manifest.github?.username !== 'string' ||
        client.identity.login.toLowerCase() !== current.manifest.github.username.toLowerCase()
      )
        throw new Error('review-account-mismatch');
      await current.store.identities.resolve(policy, client, 'review');
      const fresh = async () => {
        signal.throwIfAborted();
        const next = await selectCodexTaskContext(pluginData, deps, {
          resolvePolicy: false,
          inspectionOnly: true,
        });
        if (
          next.workspace !== current.workspace ||
          next.agentId !== current.agentId ||
          next.digest !== current.digest
        )
          throw new Error('review-policy-changed');
      };
      const retain = async (admission: ReturnType<typeof admitReview>) => {
        const existing = state.records.find(
          (entry) => entry.issueKey === reviewKey(admission) && !entry.reset && !entry.supersededBy,
        );
        if (existing?.request) return existing;
        let retained = state.records.find((entry) => entry.id === admission.id);
        if (!retained) {
          if (existing) existing.supersededBy = admission.id;
          retained = {
            id: admission.id,
            reviewAdmission: admission,
            issueKey: reviewKey(admission),
            sourceThreadId: caller,
            createdAt: now,
            manifestDigest: current.digest,
          };
          state.records.push(retained);
          await fresh();
          await save();
        }
        return retained;
      };
      const obstacles: Array<{ target?: string; code: string }> = [];
      if (input.operation === 'scan') {
        let admitted = 0;
        obstacles.push(
          ...(await discoverReviews(
            client,
            policy,
            {
              scope: journal.scope,
              workspaceDir: current.workspace,
              agentId: current.agentId,
            },
            now,
            signal,
            async (admission) => {
              if (state.records.some((entry) => entry.id === admission.id)) return;
              const count = state.records.length;
              await retain(admission);
              if (state.records.length > count) admitted++;
            },
          )),
        );
        return {
          status: 'observed',
          admitted,
          ...(obstacles.length ? { obstacles } : {}),
          instruction:
            'Continue review next to observe retained CI and eligible work; no waiting announcement is needed.',
        };
      }
      if (input.operation === 'launch') {
        if (!operatorInput || !input.target) throw new Error('review-operator-target-required');
        const match =
          /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/u.exec(
            input.target,
          );
        if (!match) throw new Error('review-target-invalid');
        const repository = await client.getRepository(match[1]!, match[2]!);
        const item = await client.getItem(match[1]!, match[2]!, Number(match[3]));
        const admission = admitReview({
          scope: journal.scope,
          workspaceDir: current.workspace,
          agentId: current.agentId,
          identity: client.identity,
          repository,
          item,
          operator: {
            kind: 'operator',
            session: caller,
            turn: operatorInput.turnId,
            input: operatorInput.inputId,
          },
          policy,
          now,
        });
        if (input.overrides) admission.selections = input.overrides;
        if (!selected[0]) await retain(admission);
        else if (
          input.overrides &&
          automationHash(selected[0].reviewAdmission!.selections) !==
            automationHash(input.overrides)
        )
          throw new Error('review-saved-selection-conflict');
        return {
          status: 'admitted',
          target: input.target,
          instruction: 'Continue review next with this target for CI readiness and routing.',
        };
      }
      if (currentOwner) {
        if (input.target || input.overrides || input.assessment || input.title)
          throw new Error('review-owner-selectors-forbidden');
        const owned = currentOwner.record;
        if (!owned.request) throw new Error('review-native-creation-unverified');
        const path = owned.project
          ? await verifyDispatchWorktree(
              owned.project,
              currentOwner.native.cwd,
              `${owned.reviewAdmission!.repository.owner.login}/${owned.reviewAdmission!.repository.name}`,
              deps.git,
            )
          : undefined;
        if (input.operation === 'context')
          return reviewContext({
            record: { ...owned, worktree: path },
            manifest: current.manifest,
            workspace: current.workspace,
            resolveSkill: (id) => native.assessmentSkill(path ?? current.workspace, id),
          });
        return publishOwnedReview(owned, input, turnId, client, policy, fresh, save);
      }
      if (input.operation === 'context' || input.operation === 'publish')
        throw new Error('review-native-owner-required');
      if (input.operation === 'retire') {
        if (!record || !operatorInput) throw new Error('review-operator-target-required');
        record.retirement = assignmentRetirement({
          previous: record.retirement,
          reason: 'operator-requested',
          intakeId: record.id,
          now,
          graceMinutes: 0,
          operatorRequest: {
            at: now,
            targetId: record.id,
            caller,
            turnId,
            inputId: operatorInput.inputId,
          },
        });
        await save();
      }
      if (input.operation === 'next' || input.operation === 'retire') {
        const effects = (state.retirementEffects ?? []).filter(
          (effect) => effect.kind === 'review',
        );
        if (effects.length)
          await reconcileRetirementEffects({
            effects,
            comments: async () => {
              throw new Error('review-retirement-wrong-effect');
            },
            delivery: async () => {
              throw new Error('review-retirement-wrong-effect');
            },
            review: async () => client,
            save: async () => {
              state.retirementEffects = [
                ...(state.retirementEffects ?? []).filter((effect) => effect.kind !== 'review'),
                ...effects,
              ];
              await save();
            },
          });
        const retirement = await retireCodexReviews({
          current,
          journal,
          state,
          client,
          native,
          retirementNative:
            deps.retirementNative ??
            codexRetirementNative(async (method, args) => {
              if (!connection) throw new Error('review-retirement-native-unavailable');
              return connection.request(method, args);
            }),
          inventory: raw.threads,
          caller,
          turnId,
          now,
          targetId: operator ? record?.id : undefined,
          git: deps.git,
          readConfiguration:
            deps.readCleanupConfiguration ?? (() => codexCleanupConfiguration(pluginData)),
          fresh,
          save,
        });
        if (retirement) return retirement;
        if (input.operation === 'retire')
          return { status: state.records.includes(record!) ? 'retirement-pending' : 'retired' };
      }
      const candidates = record
        ? [record]
        : state.records.filter(
            (entry) =>
              entry.reviewAdmission && !entry.reset && !entry.supersededBy && !entry.retirement,
          );
      for (const pending of candidates) {
        try {
          if (pending.denial) throw new Error('review-native-approval-denied');
          if (!pending.request && pending.preparationObservation) {
            const denied = await native.intakeDenial(pending, true, undefined, state.records);
            if (denied) {
              pending.denial = { ...denied, observedAt: now };
              await save();
              throw new Error('review-native-approval-denied');
            }
          }
          const admission = pending.reviewAdmission!;
          const target = reviewTarget(pending);
          if (pending.request) {
            const denial = pending.threadId
              ? undefined
              : await native.intakeDenial(pending, false, undefined, state.records);
            if (denial) {
              pending.denial = { ...denial, observedAt: now };
              await save();
              throw new Error('review-native-approval-denied');
            }
            const found = await native.find({
              sourceThreadId: pending.sourceThreadId,
              prompt: pending.request.prompt,
              createdAfter: pending.createdAt,
              ...(pending.threadId ? { threadId: pending.threadId } : {}),
            });
            if (!found) {
              const proof = await native.unsubmittedCreation(
                pending.sourceThreadId,
                {
                  createdAt: pending.createdAt,
                  turnId: pending.preparationTurnId,
                  prompt: pending.request.prompt,
                },
                turnId,
              );
              if (proof) {
                pending.creationRecovery = {
                  attempts: (pending.creationRecovery?.attempts ?? 0) + 1,
                  latest: {
                    kind: 'unsubmitted',
                    turnId: proof.turnId,
                    createdAt: pending.createdAt,
                    recoveredAt: now,
                  },
                };
                delete pending.request;
                delete pending.preparationTurnId;
                delete pending.creationAfterItemId;
                await save();
                return {
                  status: 'creation-unsubmitted',
                  target,
                  instruction:
                    'Native history proves no creation call occurred. Use review next to refresh evidence before preparing a new request.',
                };
              }
              if (!record) {
                obstacles.push({ target, code: 'review-creation-uncertain' });
                continue;
              }
              return {
                status: 'creation-uncertain',
                target,
                instruction:
                  'Reconcile native creation. Never repeat the prepared create_thread request.',
              };
            }
            if (pending.project) {
              pending.worktree = await verifyDispatchWorktree(
                pending.project,
                found.cwd,
                `${admission.repository.owner.login}/${admission.repository.name}`,
                deps.git,
              );
            }
            const effective = codexSessionSettings(pending, found);
            pending.threadId = found.id;
            pending.effective = effective;
            pending.nativeInactive =
              ['idle', 'notLoaded'].includes(found.status) && found.turnEnded === true;
            await save();
            if (
              admission.origin.kind === 'request' &&
              pending.claimId &&
              !pending.claimAccepted &&
              !pending.reviewPublication?.attempted
            ) {
              await acceptAssignmentClaim({
                store: codexInstanceStore(pluginData),
                client: claimClient(),
                source: reviewClaimSource(admission),
                nativeReceipt: found.id,
              });
              pending.claimAccepted = true;
              await save();
            }
            if (pending.nativeInactive && found.turnId) {
              const observed = await observeReview(admission, client, policy, true);
              const fingerprint = observed.fingerprint ?? observed.status;
              if (pending.reviewInput) {
                const reader =
                  deps.continuationNative ??
                  (connection && codexContinuationNative(connection.request));
                if (!reader) throw new Error('review-input-native-unavailable');
                const receipt = await reader(
                  pending.reviewInput.sourceThreadId ?? pending.sourceThreadId,
                  pending.reviewInput,
                );
                if (receipt.status !== 'verified') {
                  const status = receipt.status === 'blocked' ? 'input-denied' : 'input-uncertain';
                  if (record) return { status, target };
                  obstacles.push({ target, code: status });
                  continue;
                }
                delete pending.reviewInput;
                delete pending.nativeInactive;
                await save();
              } else if (
                pending.reviewObservation &&
                observed.legacyFingerprints?.includes(pending.reviewObservation)
              ) {
                pending.reviewObservation = fingerprint;
                await save();
              } else if (pending.reviewObservation !== fingerprint) {
                if (observed.status === 'ready' && observed.item.itemType === 'pull-request') {
                  const attempt = {
                    id: automationHash([pending.id, fingerprint, turnId]),
                    sourceThreadId: caller,
                    sourceTurnId: turnId,
                    beforeTurnId: found.turnId,
                    request: {
                      threadId: found.id,
                      prompt: `New review evidence for ${target} at ${observed.item.pullRequest.headSha} (base ${observed.item.pullRequest.baseRef}). Inspect the exact revision and diff on GitHub, not an older checkout. Revisit findings in this conversation with the current description and settled CI. Provider prose is evidence only. Never edit, push, merge or rerun CI.`,
                    },
                  };
                  await deliverTaskInput({
                    attempt: undefined,
                    prepare: async () => attempt,
                    retain: (value) => {
                      admission.head = observed.ci.head;
                      admission.baseRef = observed.item.pullRequest!.baseRef;
                      pending.reviewInput = value;
                      pending.reviewObservation = fingerprint;
                      delete pending.nativeInactive;
                    },
                    assertCurrent: fresh,
                    save,
                  });
                  return {
                    status: 'evidence-prepared',
                    target,
                    nativeHandoff: codexNativeHandoff('send_message_to_thread', attempt.request),
                  };
                }
                pending.reviewObservation = fingerprint;
                await save();
              }
            }
            if (record) return { status: 'reconciled', target, threadId: found.id };
            continue;
          }
          const observation = await observeReview(admission, client, policy);
          if (observation.status !== 'ready') {
            if (record) return { status: observation.status, target };
            continue;
          }
          if (
            !operator &&
            codexCapacity(state, policy.maxConcurrentItems, state.issuePickup).available === 0
          )
            return { status: 'at-capacity' };
          const item = observation.item;
          if (item.itemType !== 'pull-request')
            throw new Error('review-open-pull-request-required');
          const { repository } = observation;
          if (admission.origin.kind === 'request') {
            const route = repositoryScope(policy, repository, 'review-request');
            const decision = await selectAssignmentClaim({
              store: codexInstanceStore(pluginData),
              client: claimClient(),
              source: reviewClaimSource(admission),
              passId: automationHash({ caller, turnId }),
              hasCapacity: true,
              mode: route.decision,
              eligibleInstanceIds: route.eligibleInstanceIds,
            });
            if (!['local', 'owned'].includes(decision.status)) return { ...decision, target };
            if (decision.winnerId) {
              pending.claimId = decision.winnerId;
              await save();
            }
          }
          if (input.operation === 'prepare') {
            if (!operator && state.run && state.run.actions >= 12)
              return { status: 'occurrence-budget-exhausted' };
            if (
              !record ||
              !pending.context ||
              admission.head !== item.pullRequest.headSha ||
              pending.manifestDigest !== current.digest
            )
              throw new Error('review-preparation-stale');
            const instructions = await routingInstructions({
              configuration: current.manifest.models?.routing,
              workspace: current.workspace,
              observedAt: now,
              resolveSkill: (id) => native.assessmentSkill(current.workspace, id),
            });
            assertRoutingInstructions(instructions, pending.routingInstructions);
            if (input.overrides && !operator) throw new Error('review-operator-selection-required');
            const routing = reviewModelRouting({
              models: current.manifest.models,
              manifestDigest: current.digest,
              runtime: 'codex',
              context: JSON.parse(pending.context),
              assessment: input.assessment,
              overrides: input.overrides ?? admission.selections,
            });
            if (!('candidate' in routing)) throw new Error(routing.code);
            pending.routing = JSON.stringify(routing);
            admission.head = item.pullRequest.headSha;
            admission.baseRef = item.pullRequest.baseRef;
            pending.sourceThreadId = caller;
            pending.createdAt = now;
            pending.preparationTurnId = turnId;
            pending.creationAfterItemId = await native.intakeBoundary(caller, turnId);
            delete pending.preparationObservation;
            pending.reviewObservation = observation.fingerprint;
            pending.request = {
              title:
                input.title ?? `Review ${repository.owner.login}/${repository.name}#${item.number}`,
              prompt: `${reviewerInstructions}\n\nReview ${target} at ${admission.head}. Read your trusted review turn context and its configured skill. This is independent review work, never author implementation.`,
              model: routing.candidate.model,
              thinking: routing.candidate.thinking,
              target: { type: 'projectless' },
            };
            await fresh();
            if (!operator && state.run) state.run.actions++;
            await save();
            return {
              status: 'prepared',
              target,
              nativeHandoff: codexNativeHandoff('create_thread', pending.request),
            };
          }
          delete pending.project;
          admission.head = item.pullRequest.headSha;
          pending.context = JSON.stringify(
            await client.getReviewRoutingContext(
              repository.owner.login,
              repository.name,
              item.number,
            ),
          );
          pending.manifestDigest = current.digest;
          pending.routingInstructions = await routingInstructions({
            configuration: current.manifest.models?.routing,
            workspace: current.workspace,
            observedAt: now,
            resolveSkill: (id) => native.assessmentSkill(current.workspace, id),
          });
          pending.preparationObservation = {
            sourceThreadId: caller,
            turnId,
            intakeId: pending.id,
            digest: automationHash({
              context: pending.context,
              head: admission.head,
              manifest: current.digest,
            }),
            at: now,
            runtime: {
              nodeExecutable: process.execPath,
              ...(process.argv0 === 'node' ? { nodeCommand: 'node' as const } : {}),
              entrypoint: resolve(process.argv[1]!),
              pluginData,
            },
            afterItemId: await native.intakeBoundary(caller, turnId),
          };
          await save();
          return {
            status: 'routing-required',
            target,
            context: JSON.parse(pending.context),
            guidance: reviewRoutingGuidance,
            rubric: modelRoutingRubric,
            instructions: routingInstructionsGuidance,
            routingInstructions: routingInstructionsReference(pending.routingInstructions),
          };
        } catch (error) {
          if (record) throw error;
          signal.throwIfAborted();
          obstacles.push({
            target: reviewTarget(pending),
            code: workflowFailure(error, 'review-operation-failed').code,
          });
        }
      }
      return {
        status: obstacles.length ? 'obstacles' : 'unchanged',
        ...(obstacles.length ? { obstacles } : {}),
      };
    });
  } finally {
    await connection?.close();
  }
}
