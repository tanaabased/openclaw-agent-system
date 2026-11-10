import { realpath } from 'node:fs/promises';
import { observeCodexActivity } from './codex-capacity-reconcile.ts';
import type { CodexWorkContext } from './codex-continuation-context.ts';
import { revalidateDispatchAssignment } from './codex-dispatch-context.ts';
import { verifyDispatchWorktree } from './codex-dispatch-project.ts';
import type { DispatchRecord, DispatchState } from './codex-dispatch-state.ts';
import { selectCodexIntake } from './codex-intake.ts';
import codexSessionSettings from './codex-session-settings.ts';
import codexWorkContext from './codex-work-context.ts';
import renderCodexWorkResult from './codex-work-result.ts';
import codexWorkState from './codex-work-state.ts';
import advanceCodexWorkTurn from './codex-work-turn.ts';
import issueProgression, { retainedIssueProgression } from './issue-progression.ts';
import issueWorkflowMode from './issue-workflow-mode.ts';
import liveWorkflowPolicy, { WorkflowPolicyHeld } from './live-workflow-policy.ts';
import { dispatchAdmission } from './managed-issue.ts';
import { selectWorkflowStage } from './workflow-stage.ts';
export async function prepareCodexWork(state: DispatchState, context: CodexWorkContext) {
  const { input, deps, current, caller, native, admissions, save } = context;
  const direction = context.operatorInput ?? context.feedbackInput;
  if (input.action === 'context')
    for (const record of state.records) {
      if (input.action === 'context' && record.id !== input.id) continue;
      if (input.action === 'context' && caller !== record.threadId)
        throw new Error('continuation-issue-caller-required');
      const admitted = dispatchAdmission(record, admissions?.records ?? []);
      if (
        codexWorkState(record) ||
        !record.project ||
        !record.worktree ||
        !record.request ||
        record.supersededBy ||
        record.retirement ||
        record.reset ||
        !admitted ||
        liveWorkflowPolicy(
          current.manifest,
          'codex',
          admitted,
          direction ? 'continued-work' : 'implementation',
        )
      )
        continue;
      {
        const selected = await selectWorkflowStage({
          stage: 'implementation',
          configuration: {
            ...current.manifest.github?.notifications?.issueAssignment?.implementation,
            ...record.manualIssue?.selections?.implementation,
          },
          workspace: current.workspace,
          observedAt: (deps.now ?? Date.now)(),
          resolveSkill: (id) => native.assessmentSkill(record.worktree!, id),
        });
        (context.preparedSelections ??= new Set()).add(record.id);
        record.nativeWork = {
          selection: selected.selection,
        };
        delete record.retry;
        delete record.retryAfter;
      }
      await save();
    }
}
export default async function advanceCodexWork(record: DispatchRecord, context: CodexWorkContext) {
  const { pluginData, input, deps, current, caller, native, git, admissions, save, signal } =
    context;
  const direction = context.operatorInput ?? context.feedbackInput;
  const liveMode = issueWorkflowMode(current.manifest.github?.notifications, record);
  try {
    const work = codexWorkState(record);
    if (
      !work ||
      !record.threadId ||
      !record.worktree ||
      !record.project ||
      !record.request ||
      record.supersededBy ||
      record.retirement ||
      record.reset
    )
      throw new Error('continuation-managed-issue-required');
    if (input.action === 'retry' || input.action === 'retry-denied')
      return {
        status: 'native' as const,
        id: record.id,
        threadId: record.threadId,
        instructions:
          'Continue in the existing native chat. Existing request receipts remain available for reconciliation; no replacement coordinator message is queued.',
      };
    if (caller !== record.threadId) throw new Error('continuation-issue-caller-required');
    const admitted = dispatchAdmission(record, admissions?.records ?? []);
    if (!admitted) throw new Error('continuation-admission-missing');
    const enteringImplementation = !retainedIssueProgression(record);
    const authorizeLive = async () => {
      await context.feedbackInput?.authorize();
      const live = await selectCodexIntake(pluginData, deps);
      const held = liveWorkflowPolicy(
        live.manifest,
        'codex',
        admitted,
        enteringImplementation && !direction ? 'implementation' : 'continued-work',
      );
      if (held) throw new WorkflowPolicyHeld(held);
      if (
        enteringImplementation &&
        issueWorkflowMode(live.manifest.github?.notifications, record) !== liveMode
      )
        throw new WorkflowPolicyHeld('workflow-mode-updated');
      return live;
    };
    if (!['reconcile', 'cancel', 'result'].includes(input.action)) await authorizeLive();
    if (!input.material) delete work.policyHeld;
    const found = await native.find({
      sourceThreadId: record.sourceThreadId,
      prompt: record.request.prompt,
      createdAfter: record.createdAt,
      threadId: record.threadId,
    });
    if (
      !found ||
      !found.turnId ||
      found.id !== record.threadId ||
      (await realpath(found.cwd)) !== (await realpath(record.worktree))
    )
      throw new Error('continuation-native-binding-mismatch');
    const transition = issueProgression(record, {
      mode: liveMode ?? 'auto',
      now: (deps.now ?? Date.now)(),
      operator: Boolean(direction),
      decision: input.decision,
    });
    if (!['reconcile', 'cancel', 'result'].includes(input.action) && transition.status !== 'ready')
      throw new WorkflowPolicyHeld(transition.reason);
    const { client, repo } = await revalidateDispatchAssignment(
      current,
      admitted,
      deps,
      signal,
      true,
      record,
    );
    observeCodexActivity(record, found, (deps.now ?? Date.now)());
    await verifyDispatchWorktree(
      record.project,
      found.cwd,
      admitted.repository.owner.login + '/' + admitted.repository.name,
      git,
      'handoff',
    );
    if (input.material) {
      if (!retainedIssueProgression(record))
        throw new Error('implementation-material-context-required');
      return codexWorkContext(
        record,
        context,
        { client, repo, admitted, selection: work.selection },
        true,
      );
    }
    record.effective = codexSessionSettings(record, found);
    await save();
    if (input.action === 'cancel') {
      work.cancelled = true;
      await save();
      return { status: 'cancelled' as const, id: record.id };
    }
    let selection = work.selection;
    if (input.action === 'context' && !context.preparedSelections?.has(record.id)) {
      const currentSelection = await selectWorkflowStage({
        stage: 'implementation',
        configuration: {
          ...current.manifest.github?.notifications?.issueAssignment?.implementation,
          ...record.manualIssue?.selections?.implementation,
        },
        workspace: current.workspace,
        observedAt: (deps.now ?? Date.now)(),
        resolveSkill: (id) => native.assessmentSkill(found.cwd, id),
      });
      selection = currentSelection.selection;
    }
    if (input.action !== 'reconcile' && input.action !== 'result') await authorizeLive();
    const turn = await advanceCodexWorkTurn(record, context, {
      admitted,
      found: { ...found, turnId: found.turnId },
      transition,
      selection,
    });
    if (!turn.ready) return turn.response;
    if (input.action === 'context' && input.decision)
      record.implementationDecision = input.decision;
    delete work.code;
    await save();
    if (input.action === 'context') {
      if (record.handoff) {
        delete record.handoff;
        await save();
      }
      return await codexWorkContext(record, context, {
        client,
        repo,
        admitted,
        selection: turn.selection,
      });
    }
    if (input.action === 'result') return renderCodexWorkResult(record, context);
    if (input.action === 'delivery') {
      if (work.scope === 'local') throw new Error('implementation-publication-not-authorized');
      return { status: 'deliver' as const, id: record.id };
    }
  } catch (error) {
    if (error instanceof WorkflowPolicyHeld && codexWorkState(record)) {
      codexWorkState(record)!.policyHeld = error.reason;
      await save();
      return {
        status: 'policy-held' as const,
        id: record.id,
        reason: error.reason,
        continuationRequest: { action: 'context' as const, id: record.id },
      };
    }
    throw error;
  }
}
