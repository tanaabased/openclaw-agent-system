import { nativeIssueContext } from './native-issue-context.ts';
import { dispatchAdmission, managedTargetUrl } from './managed-issue.ts';

import { realpath } from 'node:fs/promises';
import connectCodexGitHubAccount from './codex-github-client.ts';
import type { ImplementationResult } from './implementation-result.ts';
import managedImplementationRoute from './managed-implementation-route.ts';

import type { AssessmentEntryDependencies } from './assessment-entry.ts';
import assessmentOwner from './assessment-owner.ts';
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
  const nativeRead =
    !!input &&
    typeof input === 'object' &&
    'action' in input &&
    input.action === 'assessment' &&
    'operation' in input &&
    input.operation === 'context';
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
      if (!record.worktree) throw new Error('assessment-managed-checkout-unavailable');
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
      return {
        selections: record.manualIssue?.selections,
        nativeContext: nativeRead ? nativeIssueContext(record) : undefined,
        digest,
        owner: { id: record.id },
        path: await realpath(record.worktree!),
        selection: record.assessment,
        evidence: record.context,
      };
    };
    const records = (await journal.read()).records.filter((record) => record.threadId === caller);
    if (records.length > 1) throw new Error('assessment-managed-owner-ambiguous');
    const admission =
      records[0] && dispatchAdmission(records[0], (await current.store.read())?.records ?? []);
    if (records.length && !admission) throw new Error('assessment-managed-admission-missing');
    const currentTarget = admission ? managedTargetUrl(admission) : undefined;
    const nativeContextRequest =
      !!records[0] &&
      nativeRead &&
      !!input &&
      typeof input === 'object' &&
      'operation' in input &&
      input.operation === 'context' &&
      (!('target' in input) || input.target === undefined || input.target === currentTarget);
    const readOnlyNative =
      nativeContextRequest &&
      admission &&
      Boolean(
        (
          await managed({
            repository: `${admission.repository.owner.login}/${admission.repository.name}`,
            number: admission.issue.number,
          })
        )?.nativeContext,
      );
    if (routeManaged) {
      const routed = await managedImplementationRoute({
        action: input,
        currentTarget,
        managed,
        route: routeManaged,
      });
      if (routed) return routed.result;
    }
    const turn = readOnlyNative ? undefined : await codexDirectInput(connection.request, caller);
    const assertCurrent = async () => {
      const fresh = await selectCodexIntake(pluginData, deps, { resolvePolicy: false });
      if (
        fresh.store.location.scope !== current.store.location.scope ||
        fresh.agentId !== current.agentId ||
        fresh.workspace !== current.workspace ||
        fresh.codexHome !== current.codexHome
      )
        throw new Error('assessment-binding-changed');
      const next = turn && (await codexDirectInput(connection.request, caller));
      if (turn && next && (next.turnId !== turn.turnId || next.inputId !== turn.inputId))
        throw new Error('assessment-native-input-changed');
      entry.manifest = fresh.manifest;
    };
    const entry: AssessmentEntryDependencies = {
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
      turnId: turn?.turnId ?? '',
      inputId: turn?.inputId ?? '',
      message: turn?.message,
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
    };
    return await collect(entry);
  } finally {
    await connection.close();
  }
}
