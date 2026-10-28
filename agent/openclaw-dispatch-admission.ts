import { dispatchAdmission, managedPullRequest } from './managed-issue.ts';
import verifyIssuePullRequest from './issue-pr-selection.ts';
import openClawRoutingInstructions from './openclaw-routing-instructions.ts';
import { assertRoutingInstructions, routingInstructionsDigest } from './routing-instructions.ts';
import assertDormantAssignmentUnclaimed from './dormant-assignment-claim.ts';
import type { Static } from 'typebox';

import type { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import { automationHash } from './automation-hash.ts';
import dispatchRoutingAssessment from './dispatch-routing-assessment.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import { selectOpenClawAssessment } from './openclaw-assessment.ts';
import dispatchCapacity from './openclaw-capacity.ts';
import {
  type default as OpenClawDispatchContext,
  type OpenClawDispatchTransaction,
  type OpenClawDispatchValidation,
} from './openclaw-dispatch-context.ts';

import { type OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import { sameIntakeRun } from './openclaw-intake-pass.ts';
import createIssueSession from './openclaw-session-create.ts';
import advanceIssueTurn from './openclaw-session-turn.ts';
import managedGroupName from '../utils/managed-group-name.ts';

function digest(record: OpenClawDispatchRecord) {
  return automationHash({
    context: record.context,
    ...(record.adoptedPullRequest ? { adoptedPullRequest: record.adoptedPullRequest } : {}),
    manifest: record.manifestDigest,
    instructions:
      record.routingInstructions && routingInstructionsDigest(record.routingInstructions),
  });
}
export default class OpenClawDispatchAdmission {
  constructor(readonly context: OpenClawDispatchContext) {}
  async run(
    input: Static<typeof dispatchParameters>,
    record: OpenClawDispatchRecord,
    tx: OpenClawDispatchTransaction,
    verified: OpenClawDispatchValidation,
    setStage: (stage: OpenClawDispatchRecord['failureStage']) => void,
  ) {
    const {
      manifest,
      workspace,
      caller,
      authority,
      current,
      state,
      save,
      transactionSignal,
      sourceThreadId,
      now,
    } = tx;
    const { client, intake, worktreeInput } = verified;
    const claims = this.context.dependencies.claims;
    const verifyPr = async () => {
      if (!record.adoptedPullRequest) return;
      const connection = await this.context.dependencies.delivery?.({
        manifest,
        workspaceDir: workspace,
        worktree: record.worktree ?? workspace,
        caller,
        signal: transactionSignal,
      });
      if (!connection) throw new Error('delivery-runtime-unavailable');
      await verifyIssuePullRequest(intake, record.adoptedPullRequest, connection.account);
    };
    await verifyPr();
    if (
      !('initiation' in intake) &&
      !claims &&
      !record.sessionCreation?.attempted &&
      !record.sessionCreation?.verified
    )
      await assertDormantAssignmentUnclaimed(this.context.dependencies.claimStore, intake);
    if (!('initiation' in intake) && claims && !record.sessionCreation?.verified) {
      const claim = await claims.select({
        intake,
        client,
        caller,
        hasCapacity:
          Boolean(record.request) ||
          dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems).available > 0,
      });
      if (claim.status !== 'owned') {
        if (claim.status === 'recovery-required') throw new Error(claim.code);
        return {
          status: 'claim-waiting' as const,
          id: record.id,
          claim,
          nextAction: 'next' as const,
        };
      }
      record.claimId = claim.winnerId;
      await save();
    }
    if (input.action === 'prepare') {
      const pass = state.openclawPasses?.find((entry) => sameIntakeRun(entry, caller));
      if (!record.manualIssue && !pass?.selected.includes(record.id))
        throw new Error('dispatch-pass-selection-required');
      if (record.request) return { status: 'reconcile-required' as const, id: record.id };
      if (!dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems).available)
        return { status: 'at-capacity' as const, id: record.id };
      if (record.phase !== 'routing' || input.digest !== digest(record) || !record.context)
        throw new Error('dispatch-preparation-stale');
      setStage('routing');
      const instructions = await openClawRoutingInstructions(this.context, tx);
      assertRoutingInstructions(instructions, record.routingInstructions);
      const metadata = JSON.parse(record.context).metadata?.complexity;
      const routing = resolveModelRoutingRequest(
        manifest.models,
        current.manifestDigest,
        {
          action: 'resolve',
          manifestDigest: current.manifestDigest,
          context: record.context.slice(0, 17950) + '\n[Bounded routing snapshot.]',
          assessment: dispatchRoutingAssessment(input.assessment, metadata),
          ...(record.manualIssue?.selections?.routing
            ? { overrides: record.manualIssue.selections.routing }
            : {}),
          ...(metadata?.status === 'verified'
            ? { evidence: { complexity: metadata.value, source: metadata.source } }
            : {}),
          ...(input.fallback ? { fallback: input.fallback } : {}),
        },
        'openclaw',
      );
      if (!('candidate' in routing) || routing.candidate?.status !== 'mapped')
        throw new Error('dispatch-routing-unresolved');
      setStage('worktree');
      if (!record.worktree && !record.worktreeAttemptId) {
        // Save before Git runs so a lost preparation result still retries the same attempt.
        record.worktreeAttemptId = record.id;
        await save();
      }
      const worktree = await this.context.dependencies.worktrees.prepareGitHub({
        ...worktreeInput,
        ...(record.adoptedPullRequest ? { startingCommit: record.adoptedPullRequest.head } : {}),
        attemptId: record.worktreeAttemptId,
        title: input.title,
      });
      record.worktree = worktree.path;
      if (record.adoptedPullRequest) record.adoptedLocalBranch = worktree.branch;
      if (record.adoptedPullRequest) {
        if (!this.context.dependencies.assessmentGit) throw new Error('assessment-git-unavailable');
        const head = await this.context.dependencies.assessmentGit({
          manifest,
          workspace,
          caller,
          cwd: record.worktree,
          argv: ['rev-parse', '--verify', 'HEAD'],
          signal: transactionSignal,
        });
        if (head.trim() !== record.adoptedPullRequest.head)
          throw new Error('launch-pr-head-changed');
        await verifyPr();
      }
      record.routing = JSON.stringify(routing);
      record.routingInstructions = instructions;
      record.routingNote = `Requested ${routing.candidate.model} / ${routing.candidate.thinking}; session settings are verified at creation, not model execution.`;
      delete record.retry;
      delete record.retryAfter;
      record.request = {
        key: `agent:${manifest.agent.id}:dashboard:agent-system-issue-${record.id}`,
        idempotencyKey: record.id,
        agentId: manifest.agent.id,
        label: `#${intake.issue.number}: ${input.title.trim()}`,
        category: managedGroupName(intake.repository.name, 512),
        cwd: worktree.path,
        model: routing.candidate.model,
        thinkingLevel: routing.candidate.thinking,
      };
      record.sessionCreation = {
        attempted: false,
        sourceSessionId: caller.sessionId,
        sourceRunId: caller.runId,
        sourceToolCallId: caller.toolCallId,
      };
      record.phase = 'creating';
      setStage('verification');
      await this.context.validateLocal(manifest, workspace, record);
      await save();
    }
    if (
      input.action === 'prepare' ||
      input.action === 'reconcile' ||
      input.action === 'start' ||
      input.action === 'assess'
    ) {
      if (!record.sessionCreation || !record.request)
        throw new Error('dispatch-session-creation-required');
      if (
        record.request.agentId !== manifest.agent.id ||
        record.request.key !==
          `agent:${manifest.agent.id}:dashboard:agent-system-issue-${record.id}` ||
        record.request.idempotencyKey !== record.id ||
        managedGroupName(record.request.category, 512) !==
          managedGroupName(intake.repository.name, 512)
      )
        throw new Error('dispatch-session-binding-changed');
      const assessment = input.action === 'assess' || Boolean(record.assessmentTurn);
      const working = assessment || input.action === 'start' || Boolean(record.firstTurn);
      setStage(assessment ? 'assessment-turn' : working ? 'first-turn' : 'session-create');
      const signal = authority.signal
        ? AbortSignal.any([authority.signal, transactionSignal])
        : transactionSignal;
      const turnAuthority = {
        signal,
        assertCurrent: async () => {
          signal.throwIfAborted();
          await authority.assertCurrent?.();
          if (
            !record.manualIssue &&
            (await this.context.dependencies.coordinator(manifest, current.workspace)) !==
              sourceThreadId
          )
            throw new Error('dispatch-coordinator-binding-changed');
          await this.context.validateLocal(manifest, workspace, record);
          signal.throwIfAborted();
        },
      };
      if (assessment && !record.assessmentTurn) {
        await turnAuthority.assertCurrent();
        await this.context.dependencies.credential.use(turnAuthority, async (request) => {
          await selectOpenClawAssessment({
            request,
            record,
            workspace: current.workspace,
            configuration: {
              ...current.policy.policy.issueAssignment?.assessment,
              ...record.manualIssue?.selections?.assessment,
            },
            now,
          });
          await turnAuthority.assertCurrent();
          await save();
        });
      }
      if (record.predecessorId) {
        const predecessor = state.records.find((r) => r.id === record.predecessorId);
        const admission =
          predecessor && dispatchAdmission(predecessor, current.admitted.records ?? []);
        if (predecessor && admission && !('initiation' in admission) && claims) {
          await createIssueSession({
            config: this.context.dependencies.config(),
            credential: this.context.guardedCredential(() =>
              this.context.validate(manifest, workspace, record, false, false, client, signal),
            ),
            record,
            save,
            authority: turnAuthority,
          });
          if (!record.sessionCreation?.verified || !record.sessionCreation.sessionId)
            throw new Error('claim-native-creation-unverified');
          const accepted = await claims.recover(
            admission,
            client,
            predecessor,
            record.id,
            'accept',
            record.sessionCreation.sessionId,
          );
          if (accepted) {
            record.claimId = accepted.commentId;
            record.claimAccepted = true;
            await save();
          }
        } else if (predecessor?.claimId || predecessor?.claimAccepted)
          throw new Error('claim-recovery-owner-unresolved');
      }
      const result = await (working ? advanceIssueTurn : createIssueSession)({
        config: this.context.dependencies.config(),
        credential: this.context.guardedCredential(async (method) => {
          const checked = await this.context.validate(
            manifest,
            workspace,
            record,
            false,
            false,
            client,
            signal,
          );
          if (
            method === 'sessions.create' &&
            managedPullRequest(intake) &&
            checked.item.pullRequest?.headSha !== managedPullRequest(intake)?.headSha
          )
            throw new Error('launch-pull-request-head-changed');
          return checked;
        }),
        record,
        save,
        authority: turnAuthority,
        assessment,
        presentation: { intake, workspace: current.workspace, debug: manifest.debug },
      });
      if (
        !('initiation' in intake) &&
        claims &&
        record.claimId &&
        !record.claimAccepted &&
        record.sessionCreation?.verified
      ) {
        await claims.accept(intake, client, record);
        record.claimAccepted = true;
        await save();
      }
      return result;
    }
    throw new Error('dispatch-action-invalid');
  }
}
