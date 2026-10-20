import type { Static } from 'typebox';

import type { dispatchParameters } from '../tools/dispatch/tool-schema.ts';
import { automationHash } from './automation-hash.ts';
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

function digest(record: OpenClawDispatchRecord) {
  return automationHash({ context: record.context, manifest: record.manifestDigest });
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
    if (input.action === 'prepare') {
      const pass = state.openclawPasses?.find((entry) => sameIntakeRun(entry, caller));
      if (!pass?.selected.includes(record.id)) throw new Error('dispatch-pass-selection-required');
      if (record.request) return { status: 'reconcile-required' as const, id: record.id };
      if (!dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems).available)
        return { status: 'at-capacity' as const, id: record.id };
      if (record.phase !== 'routing' || input.digest !== digest(record) || !record.context)
        throw new Error('dispatch-preparation-stale');
      setStage('routing');
      const metadata = JSON.parse(record.context).metadata?.complexity;
      const routing = resolveModelRoutingRequest(
        manifest.models,
        current.manifestDigest,
        {
          action: 'resolve',
          manifestDigest: current.manifestDigest,
          context: record.context.slice(0, 17950) + '\n[Bounded routing snapshot.]',
          assessment: input.assessment,
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
      const worktree = await this.context.dependencies.worktrees.prepareGitHub({
        ...worktreeInput,
        title: input.title,
      });
      record.worktree = worktree.path;
      record.routing = JSON.stringify(routing);
      record.routingNote = `Requested ${routing.candidate.model} / ${routing.candidate.thinking}; session settings are verified at creation, not model execution.`;
      delete record.retry;
      delete record.retryAfter;
      record.request = {
        key: `agent:${manifest.agent.id}:dashboard:agent-system-issue-${record.id}`,
        idempotencyKey: record.id,
        agentId: manifest.agent.id,
        label: `#${intake.issue.number}: ${input.title.trim().toUpperCase()}`,
        category: intake.repository.name,
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
      if (!record.sessionCreation || !record.request || !('key' in record.request))
        throw new Error('dispatch-legacy-handoff-retained');
      if (
        record.request.agentId !== manifest.agent.id ||
        record.request.key !==
          `agent:${manifest.agent.id}:dashboard:agent-system-issue-${record.id}` ||
        record.request.idempotencyKey !== record.id ||
        record.request.category !== intake.repository.name
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
            configuration: current.policy.policy.issueAssignment?.assessment,
            now,
          });
          await turnAuthority.assertCurrent();
          await save();
        });
      }
      return (working ? advanceIssueTurn : createIssueSession)({
        config: this.context.dependencies.config(),
        credential: this.context.guardedCredential(() =>
          this.context.validate(manifest, workspace, record, false, false, client, signal),
        ),
        record,
        save,
        authority: turnAuthority,
        assessment,
        presentation: { intake, workspace: current.workspace, debug: manifest.debug },
      });
    }
    throw new Error('dispatch-action-invalid');
  }
}
