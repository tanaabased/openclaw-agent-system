import { randomUUID } from 'node:crypto';

import type { Static } from 'typebox';

import { assessmentResultSchema } from './assessment-result.ts';
import { assessmentInstructions } from './assessment-instructions.ts';
import assessmentPresentation from './dispatch-presentation.ts';
import { automationHash } from './automation-hash.ts';
import dispatchCapacity from './dispatch-capacity.ts';
import dispatchContext from './dispatch-context.ts';
import pendingAssignments, { issueKey } from './dispatch-pending.ts';
import revalidateAssignment from './dispatch-assignment.ts';
import recordDispatchResult from './dispatch-result.ts';
import resolveModelRoutingRequest from './model-routing-request.ts';
import { assessmentSchema } from './model-routing.ts';
import OpenClawDispatchHandoff, {
  type DispatchCaller,
  type DispatchHandoffHost,
} from './openclaw-dispatch-handoff.ts';
import OpenClawDispatchStore, { type OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type OpenClawIntake from './openclaw-intake.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
import type { CodexAssessmentSkill } from './codex-assessment-skill.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';
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
  preflight(manifest: AgentManifest): void;
  native: Pick<DispatchHandoffHost, 'read'>;
  skill(workspace: string, sessionKey: string, id: string): Promise<CodexAssessmentSkill>;
  now?: () => number;
}

function source(intake: IntakeRecord) {
  return `https://github.com/${intake.repository.owner.login}/${intake.repository.name}/issues/${intake.issue.number}`;
}
function digest(record: OpenClawDispatchRecord) {
  return automationHash({ context: record.context, manifest: record.manifestDigest });
}
function failureCode(error: unknown) {
  return error instanceof Error && /^[a-z][a-z0-9-]{2,127}$/.test(error.message)
    ? error.message
    : 'dispatch-operation-failed';
}

/** The coordinator supplies judgment; admission, effects and results remain host-verified. */
export default class OpenClawDispatch {
  constructor(readonly dependencies: OpenClawDispatchDependencies) {}

  private async block(store: OpenClawDispatchStore, id: string, error: unknown) {
    const code = failureCode(error);
    await store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (record) {
        record.blocker = code;
        if (record.phase !== 'complete') record.phase = 'blocked';
        await save();
      }
    }, true);
    return { status: 'blocked' as const, id, code };
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

  async handoff(manifest: AgentManifest, workspace: string) {
    const current = await this.scope(manifest, workspace);
    return new OpenClawDispatchHandoff(current.journal, {
      ...this.dependencies.native,
      validate: async (record) => {
        await this.validate(manifest, workspace, record);
      },
    });
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
    const recoverable = state.records.some(
      (record) =>
        !record.blocker &&
        !record.retired &&
        record.native &&
        record.setupComplete &&
        !record.continuation,
    );
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
    actualModel?: string,
    operator = false,
  ) {
    if (input.action === 'check') return this.check(manifest, workspace);
    const current = await this.scope(manifest, workspace);
    const sourceThreadId = await this.dependencies.coordinator(manifest, current.workspace);
    const child = input.action === 'context' || input.action === 'result';
    if (input.action === 'retry' && !operator) throw new Error('dispatch-operator-required');
    if (
      !child &&
      caller.sessionKey !== sourceThreadId &&
      !(operator && ['inspect', 'retry'].includes(input.action))
    )
      throw new Error('dispatch-intake-caller-required');
    const handoff = await this.handoff(manifest, workspace);
    if (input.action === 'reconcile')
      return handoff
        .reconcile(input.id, caller.sessionKey, (this.dependencies.now ?? Date.now)())
        .catch((error: unknown) => this.block(current.journal, input.id, error));
    if (child) {
      if (!actualModel) throw new Error('dispatch-native-execution-unavailable');
      await handoff.verifyExecution(input.id, caller, actualModel);
    }
    return current.journal
      .exclusive(async (state, save) => {
        if (input.action === 'inspect')
          return {
            status: 'ready',
            records: state.records.map((record) => ({
              id: record.id,
              intakeId: record.intakeId,
              phase: record.phase,
              threadId: record.threadId,
              effective: record.effective,
              execution: record.execution,
              blocker: record.blocker,
              outcome: record.result?.outcome,
            })),
          };
        const now = (this.dependencies.now ?? Date.now)();
        if (input.action === 'next') {
          const recoverable = state.records.find(
            (record) =>
              !record.blocker &&
              !record.retired &&
              record.native &&
              record.setupComplete &&
              !record.continuation,
          );
          if (recoverable) return { status: 'reconcile-required', id: recoverable.id };
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
          delete record.context;
          await save();
          return {
            status: 'routing-required',
            id: record.id,
            instruction: 'The owning coordinator must call next for a fresh evidence snapshot.',
          };
        }
        const { intake, worktreeInput } = await this.validate(manifest, workspace, record);
        if (input.action === 'prepare') {
          if (record.request) return { status: 'reconcile-required', id: record.id };
          if (!dispatchCapacity(state.records, current.policy.policy.maxConcurrentItems).available)
            return { status: 'at-capacity', id: record.id };
          if (record.phase !== 'routing' || input.digest !== digest(record) || !record.context)
            throw new Error('dispatch-preparation-stale');
          this.dependencies.preflight(manifest);
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
          const worktree = await this.dependencies.worktrees.prepareGitHub({
            ...worktreeInput,
            title: input.title,
          });
          const selected = await selectWorkflowStage({
            stage: 'assessment',
            configuration: current.policy.policy.issueAssignment?.assessment,
            workspace: current.workspace,
            observedAt: now,
            resolveSkill: (id) => this.dependencies.skill(worktree.path, caller.sessionKey, id),
          });
          record.assessment = selected.selection;
          record.worktree = worktree.path;
          record.routing = JSON.stringify(routing);
          record.routingNote = `Requested ${routing.candidate.model} / ${routing.candidate.thinking}; native execution is not yet verified.`;
          record.request = {
            runtime: 'subagent',
            visible: true,
            cleanup: 'keep',
            expectsCompletionMessage: false,
            label: `#${intake.issue.number}: ${input.title.trim().toUpperCase()}`,
            group: `${intake.repository.owner.login}/${intake.repository.name}`,
            cwd: worktree.path,
            model: routing.candidate.model,
            task: `Agent System setup only. Receipt ${record.id}. Do not investigate, assess, modify files, delegate, or publish. Do not call tools. Reply only: Setup ready. Assessment will arrive in a separate turn after the host verifies model and effort.`,
          };
          record.phase = 'creating';
          await this.validate(manifest, workspace, record);
          await save();
          return {
            status: 'prepared',
            id: record.id,
            request: record.request,
            instruction:
              'Call native sessions_spawn exactly once with request unchanged. Then reconcile this id. Never repeat an uncertain creation or reconstruct the request.',
          };
        }
        if (input.action === 'context' || input.action === 'result') {
          if (record.execution?.runId !== caller.runId || !record.assessment || !record.worktree)
            throw new Error('dispatch-assessment-caller-mismatch');
          const skill = await this.dependencies.skill(
            record.worktree,
            caller.sessionKey,
            record.assessment.requestedSkill,
          );
          if (automationHash(skill) !== automationHash(record.assessment.skill))
            throw new Error('dispatch-assessment-skill-changed');
          if (input.action === 'context')
            return {
              status: 'verified',
              id: record.id,
              evidence: JSON.parse(record.context!),
              routing: JSON.parse(record.routing!),
              routingNote: record.routingNote,
              effective: record.effective,
              execution: record.execution,
              assessment: record.assessment,
              project: { path: record.worktree },
              currentTurnId: caller.runId,
              previousResult: record.result,
              previousResultTurnId: record.resultTurnId,
              ...(record.result
                ? {
                    previousResultDigest: automationHash(record.result),
                    previousPresentation: assessmentPresentation(
                      record.result,
                      record,
                      intake,
                      current.workspace,
                    ),
                  }
                : {}),
              resultContract: 'assessment-result/v1',
              resultSchema: assessmentResultSchema,
              dispatchRuntime: {
                runtime: 'openclaw',
                tool: 'agent_system_dispatch',
                id: record.id,
              },
              instructions:
                assessmentInstructions +
                '\n\nSubmit through native agent_system_dispatch with action result, this id and result matching resultSchema. Include previousResultDigest when revising. On conflict reload context. After acknowledgment reproduce the entire returned presentation. No CLI, implementation, or publication.',
            };
          const result = recordDispatchResult({
            record,
            intake,
            threadId: caller.sessionKey,
            turnId: caller.runId,
            worktree: record.worktree,
            policy: manifest.github?.notifications,
            result: input.result,
            previousResultDigest: input.previousResultDigest,
          });
          await save();
          return {
            status: 'recorded',
            id: record.id,
            outcome: result.outcome,
            previousResultDigest: automationHash(result),
            presentation: assessmentPresentation(result, record, intake, current.workspace),
          };
        }
        throw new Error('dispatch-action-invalid');
      }, child)
      .catch((error: unknown) => {
        if (input.action === 'prepare') return this.block(current.journal, input.id, error);
        throw error;
      });
  }
}
