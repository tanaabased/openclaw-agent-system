import { randomUUID } from 'node:crypto';

import type { Static } from 'typebox';

import { issueAssessmentAction, selectOpenClawAssessment } from './openclaw-assessment.ts';
import createIssueSession, { type DispatchCaller } from './openclaw-session-create.ts';
import advanceIssueTurn from './openclaw-session-turn.ts';
import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import type { DispatchAuthority } from '../credentials/session-dispatch.ts';

import { automationHash } from './automation-hash.ts';
import dispatchCapacity from './dispatch-capacity.ts';
import dispatchContext from './dispatch-context.ts';
import pendingAssignments, { issueKey } from './dispatch-pending.ts';
import revalidateAssignment from './dispatch-assignment.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import { assessmentSchema } from './model-routing.ts';
import OpenClawDispatchStore, { type OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type OpenClawIntake from './openclaw-intake.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';
import AgentSystemToolError from '../api/error.ts';
import GitCommandError from '../tools/git/command-error.ts';
import type { AgentManifest } from '../manifest/types.ts';
import type TrustedGitWorktreeService from '../tools/git/trusted-worktree-service.ts';
import type { dispatchParameters } from '../tools/dispatch/tool-schema.ts';

export interface OpenClawDispatchDependencies {
  root: string;
  intake: OpenClawIntake;
  connect(
    input: { manifest: AgentManifest; workspaceDir: string },
    signal: AbortSignal,
  ): Promise<GitHubNotificationIntakeClient & GitHubNotificationItemContextClient>;
  worktrees: Pick<TrustedGitWorktreeService, 'prepareGitHub' | 'inspectGitHub'>;
  coordinator(manifest: AgentManifest, workspace: string): Promise<string>;
  credential: Pick<SessionDispatchCredential, 'use'>;
  now?: () => number;
}

function source(intake: IntakeRecord) {
  return `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/issues/${intake.issue.number}`;
}
function digest(record: OpenClawDispatchRecord) {
  return automationHash({ context: record.context, manifest: record.manifestDigest });
}
function failureCode(error: unknown): string {
  if (error instanceof GitCommandError) return error.diagnosticCode;
  if (error instanceof AgentSystemToolError) {
    if (error.cause instanceof GitCommandError) return error.cause.diagnosticCode;
    return `dispatch-tool-${error.code.replaceAll('_', '-')}`;
  }
  return error instanceof Error && /^[a-z][a-z0-9-]{2,127}$/.test(error.message)
    ? error.message
    : 'dispatch-operation-failed';
}

/** the coordinator supplies routing judgment; intake and session effects stay host-verified. */
export default class OpenClawDispatch {
  constructor(readonly dependencies: OpenClawDispatchDependencies) {}

  private async block(
    store: OpenClawDispatchStore,
    id: string,
    error: unknown,
    stage?: OpenClawDispatchRecord['failureStage'],
  ) {
    const code = failureCode(error);
    await store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (record) {
        record.blocker = code;
        if (stage) record.failureStage = stage;
        if (record.phase !== 'complete') record.phase = 'blocked';
        await save();
      }
    }, true);
    return { status: 'blocked' as const, id, code, ...(stage ? { stage } : {}) };
  }

  async scope(manifest: AgentManifest, workspace: string) {
    const current = await this.dependencies.intake.select(manifest, workspace);
    const admitted = await current.store.read();
    if (!current.selected || !admitted || admitted.policyDigest !== current.selected.digest)
      throw new Error('dispatch-intake-activation-required');
    if (current.selected.policy.issueAssignment?.mode !== 'plan')
      throw new Error('dispatch-plan-mode-required');
    return {
      ...current,
      admitted,
      policy: current.selected,
      manifestDigest: automationHash({ policy: current.selected.digest, models: manifest.models }),
      journal: new OpenClawDispatchStore(this.dependencies.root, current.store.location.scope),
    };
  }

  async validate(manifest: AgentManifest, workspace: string, record: OpenClawDispatchRecord) {
    const current = await this.scope(manifest, workspace);
    const fresh = await this.dependencies.intake.dependencies.manifestService.loadForAgentId(
      manifest.agent.id,
      'service',
    );
    if (
      fresh.status !== 'loaded' ||
      fresh.scope.workspaceDir !== current.workspace ||
      (await this.scope(fresh.manifest, fresh.scope.workspaceDir)).manifestDigest !==
        current.manifestDigest ||
      current.manifestDigest !== record.manifestDigest ||
      record.retired ||
      record.reset ||
      record.handoff
    )
      throw new Error('dispatch-policy-changed');
    const intake = current.admitted.records.find((entry) => entry.id === record.intakeId);
    if (!intake) throw new Error('dispatch-admission-missing');
    const client = await this.dependencies.connect(
      { manifest, workspaceDir: current.workspace },
      AbortSignal.timeout(25000),
    );
    const repo = await revalidateAssignment(current.policy, intake, client);
    const worktreeInput = {
      agentId: manifest.agent.id,
      cloneUrl: repo.cloneUrl,
      defaultBranch: repo.defaultBranch,
      itemDatabaseId: intake.issue.databaseId,
      itemNumber: intake.issue.number,
      itemType: 'issue' as const,
      repositoryDatabaseId: repo.databaseId,
    };
    if (record.worktree) {
      const verified = await this.dependencies.worktrees.inspectGitHub(worktreeInput);
      if (verified?.path !== record.worktree) throw new Error('dispatch-worktree-diverged');
    }
    return { client, repo, intake, worktreeInput };
  }

  /** Read-only pending predicate, combined with the admission check by the quiet trigger. */
  async check(manifest: AgentManifest, workspace: string) {
    if (
      manifest.github?.notifications?.schemaVersion !== 2 ||
      manifest.github.notifications.issueAssignment?.mode !== 'plan'
    )
      return { status: 'ready' as const, changed: false };
    const current = await this.scope(manifest, workspace);
    const state = await current.journal.read();
    const capacity = dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems);
    const recoverable = state.records.some((record) => continuationStatus(record));
    const pending = pendingAssignments(state, current.admitted).some(
      ({ record, intake }) =>
        !record || (!record.request && (!record.blocker || record.intakeId !== intake.id)),
    );
    return {
      status: 'ready' as const,
      changed: recoverable || (capacity.available > 0 && pending),
    };
  }

  async run(
    manifest: AgentManifest,
    workspace: string,
    caller: DispatchCaller,
    input: Static<typeof dispatchParameters>,
    operator = false,
    authority: DispatchAuthority = {},
  ) {
    if (input.action === 'check') return this.check(manifest, workspace);
    const childAction = input.action === 'context' || input.action === 'result';
    const current = await this.scope(manifest, workspace);
    const sourceThreadId = await this.dependencies.coordinator(manifest, current.workspace);
    let preparationStage: OpenClawDispatchRecord['failureStage'] = 'validation';
    let enteredJournal = false;
    if (input.action === 'retry' && !operator) throw new Error('dispatch-operator-required');
    if (
      !childAction &&
      caller.sessionKey !== sourceThreadId &&
      !(operator && ['inspect', 'retry'].includes(input.action))
    )
      throw new Error('dispatch-intake-caller-required');
    return current.journal
      .exclusive(async (state, save, lockSignal) => {
        enteredJournal = true;
        if (input.action === 'inspect')
          return {
            status: 'ready',
            records: state.records.map((record) => ({
              id: record.id,
              intakeId: record.intakeId,
              phase: record.phase,
              threadId: record.threadId,
              effective: record.effective,
              sessionCreation: record.sessionCreation,
              firstTurn: record.firstTurn
                ? {
                    status: record.firstTurn.status,
                    runId: record.firstTurn.runId,
                    consumedByEventId: record.firstTurn.consumedByEventId,
                    replyEventId: record.firstTurn.replyEventId,
                    executionModel: record.firstTurn.executionModel,
                    executionEffort: 'unverified',
                  }
                : undefined,
              assessmentTurn: record.assessmentTurn && {
                status: record.assessmentTurn.status,
                runId: record.assessmentTurn.runId,
                consumedByEventId: record.assessmentTurn.consumedByEventId,
                replyEventId: record.assessmentTurn.replyEventId,
                executionModel: record.assessmentTurn.executionModel,
                executionEffort: 'unverified',
              },
              blocker: record.blocker,
              failureStage: record.failureStage,
              outcome: record.result?.outcome,
            })),
          };
        const now = (this.dependencies.now ?? Date.now)();
        if (input.action === 'next') {
          const continuing = state.records.find((record) => continuationStatus(record));
          if (continuing) return { status: continuationStatus(continuing)!, id: continuing.id };
          if (!dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems).available)
            return { status: 'at-capacity' };
          const pending = pendingAssignments(state, current.admitted).find(
            ({ record, intake }) =>
              !record || (!record.request && (!record.blocker || record.intakeId !== intake.id)),
          );
          if (!pending) return { status: 'idle' };
          const record: OpenClawDispatchRecord = pending.record ?? {
            id: automationHash([current.journal.scope, randomUUID()]),
            intakeId: pending.intake.id,
            issueKey: issueKey(pending.intake),
            sourceThreadId,
            phase: 'routing',
            createdAt: now,
            manifestDigest: current.manifestDigest,
          };
          if (!pending.record) state.records.push(record);
          record.intakeId = pending.intake.id;
          record.manifestDigest = current.manifestDigest;
          record.phase = 'routing';
          delete record.blocker;
          delete record.failureStage;
          try {
            const { client, repo, intake } = await this.validate(manifest, workspace, record);
            const evidence = await client.getItemContext(
              repo.owner.login,
              repo.name,
              intake.issue.number,
              'issue',
              true,
            );
            record.context = JSON.stringify(dispatchContext(evidence, source(intake), now));
            await save();
            return {
              status: 'routing-required',
              id: record.id,
              digest: digest(record),
              context: JSON.parse(record.context),
              assessmentSchema,
              routing: resolveModelRoutingRequest(
                manifest.models,
                current.manifestDigest,
                { action: 'inspect' },
                'openclaw',
              ),
            };
          } catch (error) {
            record.phase = 'blocked';
            record.blocker = failureCode(error);
            await save();
            return { status: 'blocked', id: record.id, code: record.blocker };
          }
        }
        const record = state.records.find((entry) => entry.id === input.id);
        if (!record) throw new Error('dispatch-receipt-missing');
        if (input.action === 'retry') {
          if (record.request) throw new Error('dispatch-native-recovery-required');
          record.manifestDigest = current.manifestDigest;
          await this.validate(manifest, workspace, record);
          record.phase = 'routing';
          delete record.blocker;
          delete record.failureStage;
          delete record.context;
          await save();
          return {
            status: 'routing-required',
            id: record.id,
            instruction: 'The owning coordinator must call next for a fresh evidence snapshot.',
          };
        }
        if (
          childAction &&
          (caller.sessionKey !== record.threadId ||
            caller.sessionId !== record.sessionCreation?.sessionId ||
            !record.assessmentTurn)
        )
          throw new Error('dispatch-assessment-caller-mismatch');
        const { intake, worktreeInput } = await this.validate(manifest, workspace, record);
        if (input.action === 'context' || input.action === 'result') {
          const signal = authority.signal
            ? AbortSignal.any([authority.signal, lockSignal])
            : lockSignal;
          const childAuthority = {
            signal,
            assertCurrent: async () => {
              signal.throwIfAborted();
              await authority.assertCurrent?.();
              await this.validate(manifest, workspace, record);
              signal.throwIfAborted();
            },
          };
          await childAuthority.assertCurrent();
          return this.dependencies.credential.use(childAuthority, async (request) => {
            await selectOpenClawAssessment({
              request,
              record,
              workspace: current.workspace,
              configuration: current.policy.policy.issueAssignment?.assessment,
              now,
            });
            return issueAssessmentAction({
              request,
              record,
              caller,
              intake,
              workspace: current.workspace,
              policy: manifest.github?.notifications,
              debug: manifest.debug,
              ...input,
              save,
              assertCurrent: childAuthority.assertCurrent,
            });
          });
        }
        if (input.action === 'prepare') {
          if (record.request) return { status: 'reconcile-required', id: record.id };
          if (!dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems).available)
            return { status: 'at-capacity', id: record.id };
          if (record.phase !== 'routing' || input.digest !== digest(record) || !record.context)
            throw new Error('dispatch-preparation-stale');
          preparationStage = 'routing';
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
          preparationStage = 'worktree';
          const worktree = await this.dependencies.worktrees.prepareGitHub({
            ...worktreeInput,
            title: input.title,
          });
          record.worktree = worktree.path;
          record.routing = JSON.stringify(routing);
          record.routingNote = `Requested ${routing.candidate.model} / ${routing.candidate.thinking}; session settings are verified at creation, not model execution.`;
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
          preparationStage = 'verification';
          await this.validate(manifest, workspace, record);
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
            record.sourceThreadId !== caller.sessionKey ||
            record.request.agentId !== manifest.agent.id ||
            record.request.key !==
              `agent:${manifest.agent.id}:dashboard:agent-system-issue-${record.id}` ||
            record.request.idempotencyKey !== record.id ||
            record.request.category !== intake.repository.name
          )
            throw new Error('dispatch-session-binding-changed');
          const assessment = input.action === 'assess' || Boolean(record.assessmentTurn);
          const working = assessment || input.action === 'start' || Boolean(record.firstTurn);
          preparationStage = assessment
            ? 'assessment-turn'
            : working
              ? 'first-turn'
              : 'session-create';
          const signal = authority.signal
            ? AbortSignal.any([authority.signal, lockSignal])
            : lockSignal;
          const turnAuthority = {
            signal,
            assertCurrent: async () => {
              signal.throwIfAborted();
              await authority.assertCurrent?.();
              if (
                (await this.dependencies.coordinator(manifest, current.workspace)) !==
                sourceThreadId
              )
                throw new Error('dispatch-coordinator-binding-changed');
              await this.validate(manifest, workspace, record);
              signal.throwIfAborted();
            },
          };
          if (assessment && !record.assessmentTurn) {
            await turnAuthority.assertCurrent();
            await this.dependencies.credential.use(turnAuthority, async (request) => {
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
            credential: this.dependencies.credential,
            record,
            save,
            authority: turnAuthority,
            assessment,
          });
        }
        throw new Error('dispatch-action-invalid');
      }, childAction)
      .catch((error: unknown) => {
        if (!enteredJournal) throw error;
        if (
          input.action === 'prepare' ||
          input.action === 'reconcile' ||
          input.action === 'start' ||
          input.action === 'assess'
        )
          return this.block(current.journal, input.id, error, preparationStage);
        throw error;
      });
  }
}

function continuationStatus(record: OpenClawDispatchRecord) {
  if (!record.sessionCreation || record.retired || record.handoff || record.reset) return;
  // only the accepted receipt gap is automatically recoverable, and never by another send.
  if (
    record.phase === 'blocked' &&
    record.failureStage === 'first-turn' &&
    record.blocker === 'dispatch-turn-delivery-unverified' &&
    record.sessionCreation.verified &&
    record.firstTurn &&
    ['accepted', 'consumed'].includes(record.firstTurn.status)
  )
    return 'reconcile-required';
  if (
    record.phase === 'blocked' &&
    record.failureStage === 'assessment-turn' &&
    record.blocker === 'dispatch-turn-delivery-unverified' &&
    record.assessmentTurn &&
    ['accepted', 'consumed'].includes(record.assessmentTurn.status)
  )
    return 'reconcile-required';
  if (record.blocker) return;
  if (record.assessmentTurn)
    return record.assessmentTurn.status !== 'completed' ? 'reconcile-required' : undefined;
  if (record.phase === 'creating') return 'reconcile-required';
  if (record.phase === 'created')
    return record.firstTurn && record.firstTurn.status !== 'completed'
      ? 'reconcile-required'
      : 'assessment-required';
}
