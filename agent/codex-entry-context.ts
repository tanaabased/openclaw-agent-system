import { managedTargetUrl, dispatchAdmission } from './managed-issue.ts';

import type { ImplementationResult } from './implementation-result.ts';
import managedImplementationRoute from './managed-implementation-route.ts';
import connectCodexGitHubAccount from './codex-github-client.ts';
import { realpath } from 'node:fs/promises';

import type { AssessmentEntryDependencies } from './assessment-entry.ts';
import assessmentOwner from './assessment-owner.ts';
import { automationHash } from './automation-hash.ts';
import codexAssessmentSkill from './codex-assessment-skill.ts';
import codexDirectInput from './codex-direct-input.ts';
import { withNative } from './codex-dispatch-context.ts';
import { dispatchGit } from './codex-dispatch-project.ts';
import CodexDispatchStore from './codex-dispatch-state.ts';
import type { CodexFeedbackDependencies } from './codex-feedback.ts';
import { connectCodexGitHub, selectCodexIntake } from './codex-intake.ts';
import { connectCodexThreads } from './codex-thread-client.ts';

/** standalone native account and portable binding; no OpenClaw environment or assignment. */
export default async function codexEntryContext<T>(
  pluginData: string,
  input: unknown,
  deps: CodexFeedbackDependencies,
  collect: (deps: AssessmentEntryDependencies) => Promise<T>,
  routeManaged?: (
    owner: { id: string; eventId?: string },
    result?: ImplementationResult,
  ) => Promise<T>,
) {
  const current = await selectCodexIntake(pluginData, deps, { resolvePolicy: false });
  const caller = deps.threadId ?? process.env.CODEX_THREAD_ID;
  if (!caller) throw new Error('assessment-native-caller-required');
  const connection = await (deps.replyConnection ?? connectCodexThreads)(
    current.workspace,
    current.codexHome,
  );
  try {
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const managed: AssessmentEntryDependencies['managed'] = async (target) => {
      const state = await journal.read();
      const admitted = await current.store.read();
      const owner = assessmentOwner(state.records, admitted?.records ?? [], caller, target);
      if (!owner) return;
      const { record, digest } = owner;
      const native = await withNative(current, deps, (host) =>
        host.find({
          sourceThreadId: record.sourceThreadId,
          prompt: record.request!.prompt,
          createdAfter: record.createdAt,
          threadId: record.threadId,
        }),
      );
      if (
        !native ||
        native.id !== caller ||
        (await realpath(native.cwd)) !== (await realpath(record.worktree!))
      )
        throw new Error('assessment-managed-context-invalid');
      const eventId =
        record.progression?.workOwner && record.progression.workOwner !== 'issue'
          ? record.progression.workOwner
          : record.feedback?.events.find((event) => event.attempt?.turnId === native.turnId)?.id;
      const feedback = eventId && record.feedback?.events.find((event) => event.id === eventId);
      return {
        implementationResult: feedback ? feedback.work?.result : record.continuation?.result,
        digest,
        owner: { id: record.id, ...(eventId ? { eventId } : {}) },
        path: await realpath(record.worktree!),
        selection: record.stageReceipt?.selection ?? record.assessment!,
        evidence: record.context!,
        result: record.result,
        receipt: record.stageReceipt,
        entries: async (run) =>
          journal.exclusive(async (fresh, save) => {
            const found = assessmentOwner(
              fresh.records,
              (await current.store.read())?.records ?? [],
              caller,
              target,
            );
            if (!found || found.digest !== digest)
              throw new Error('assessment-managed-context-changed');
            found.record.directAssessments ??= [];
            return run(found.record.directAssessments, save);
          }),
      };
    };
    const records = (await journal.read()).records.filter((record) => record.threadId === caller);
    if (records.length > 1) throw new Error('assessment-managed-owner-ambiguous');
    const admission =
      records[0] && dispatchAdmission(records[0], (await current.store.read())?.records ?? []);
    if (records.length && !admission) throw new Error('assessment-managed-admission-missing');
    const currentTarget = admission ? managedTargetUrl(admission) : undefined;
    if (routeManaged) {
      const routed = await managedImplementationRoute({
        action: input,
        currentTarget,
        managed,
        route: routeManaged,
      });
      if (routed) return routed.result;
    }
    const turn = await codexDirectInput(connection.request, caller);
    const assertCurrent = async () => {
      const fresh = await selectCodexIntake(pluginData, deps, { resolvePolicy: false });
      if (
        fresh.store.location.scope !== current.store.location.scope ||
        automationHash(fresh.manifest) !== automationHash(current.manifest)
      )
        throw new Error('assessment-binding-changed');
      const next = await codexDirectInput(connection.request, caller);
      if (next.turnId !== turn.turnId || next.inputId !== turn.inputId)
        throw new Error('assessment-native-input-changed');
    };
    return await collect({
      operator: true,
      root: pluginData,
      currentTarget,
      binding: {
        runtime: 'codex',
        agentId: current.agentId,
        workspace: current.workspace,
        namespace: current.codexHome,
        session: caller,
        incarnation: caller,
      },
      ...turn,
      manifest: current.manifest,
      now: (deps.now ?? Date.now)(),
      assertCurrent,
      git: deps.git ?? dispatchGit,
      connectDelivery: async (path) => {
        await assertCurrent();
        const connection = await (deps.deliveryConnect ?? connectCodexGitHubAccount)(
          current.workspace,
          AbortSignal.timeout(60000),
        );
        return {
          account: connection.account,
          git: (argv) => (deps.git ?? dispatchGit)(path, argv),
        };
      },
      connectProvider: () =>
        (deps.connect ?? connectCodexGitHub)(current.workspace, AbortSignal.timeout(60000)),
      resolveSkill: (id) => codexAssessmentSkill(connection.request, current.workspace, id),
      managed,
    });
  } finally {
    await connection.close();
  }
}
