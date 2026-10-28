import { routingInstructionsDigest } from './routing-instructions.ts';
import { Value } from 'typebox/value';

import { launchRequestSchema } from '../tools/dispatch/launch-schema.ts';
import { automationHash } from './automation-hash.ts';
import codexEntryContext from './codex-entry-context.ts';
import { prepareDispatch, prepareIssueProject, recover } from './codex-dispatch-admission.ts';
import { connectCodexGitHub, selectCodexIntake } from './codex-intake.ts';
import type {
  CodexDispatchDependencies,
  CodexDispatchTransaction,
} from './codex-dispatch-context.ts';
import CodexDispatchStore, { type DispatchRecord } from './codex-dispatch-state.ts';
import issueLaunch from './issue-launch.ts';
import { dispatchAdmission, managedIssueState } from './managed-issue.ts';
import retainedIntakePolicy from './retained-intake-policy.ts';

/** an operator-native admission uses the same preparation and creation request as scheduled work. */
export default async function codexIssueLaunch(
  pluginData: string,
  input: unknown,
  deps: CodexDispatchDependencies,
) {
  if (!Value.Check(launchRequestSchema, input)) throw new Error('launch-request-invalid');
  return codexEntryContext(pluginData, input, deps, async (context) => {
    const current = await selectCodexIntake(pluginData, deps, { resolvePolicy: false });
    const journal = new CodexDispatchStore(
      current.store.location.root,
      current.store.location.scope,
    );
    const signal = AbortSignal.timeout(60000);
    const client = await (deps.connect ?? connectCodexGitHub)(current.workspace, signal);
    const admitted = await issueLaunch<DispatchRecord>({
      action: input,
      context,
      journal,
      scope: current.store.location.scope,
      client,
      create: (record) => record,
      verifyExisting: async (record) => {
        const issue = dispatchAdmission(record, (await current.store.read())?.records ?? []);
        if (!issue) throw new Error('dispatch-admission-missing');
        await recover(
          current,
          structuredClone(record),
          issue,
          deps,
          async () => {},
          undefined,
          record.continuation ? 'handoff' : 'assessment',
          false,
        );
      },
    });
    if (input.operation === 'context' || admitted.status === 'clarification-needed') {
      if (admitted.status === 'routing-required') {
        const record = (await journal.read()).records.find((entry) => entry.id === admitted.id);
        if (record?.project)
          return {
            ...admitted,
            digest: automationHash({
              context: record.context,
              ...(record.adoptedPullRequest
                ? { adoptedPullRequest: record.adoptedPullRequest }
                : {}),
              project: record.project,
              manifest: record.manifestDigest,
              instructions:
                record.routingInstructions && routingInstructionsDigest(record.routingInstructions),
            }),
          };
      }
      return admitted;
    }
    if (!input.id || !('id' in admitted) || input.id !== admitted.id)
      throw new Error('launch-receipt-required');
    return journal.exclusive(async (state, save, lockSignal) => {
      const record = state.records.find((entry) => entry.id === input.id);
      if (
        !record?.manualIssue ||
        record.sourceThreadId !== context.binding.session ||
        (admitted.status === 'existing' &&
          (record.result || record.handoff || input.operation !== 'reconcile'))
      )
        return admitted;
      const admissions = managedIssueState(await current.store.read(), state.records)!;
      current.policy = retainedIntakePolicy(current.manifest, admissions, 'codex');
      const issue = dispatchAdmission(record, admissions.records)!;
      const tx: CodexDispatchTransaction = {
        pluginData,
        current,
        deps,
        state,
        admitted: admissions,
        activation: { sourceThreadId: context.binding.session },
        caller: context.binding.session,
        now: context.now,
        signal: lockSignal,
        save,
        fresh: context.assertCurrent,
        operatorInput: { turnId: context.turnId, inputId: context.inputId },
      };
      if (input.operation === 'reconcile') {
        const native = await recover(
          current,
          record,
          issue,
          deps,
          save,
          undefined,
          'assessment',
          true,
          state.records,
        );
        return {
          status: 'existing' as const,
          id: record.id,
          destination: native.id,
          effective: record.effective,
          instruction:
            'Continue the saved issue stage in this native destination; never repeat creation.',
        };
      }
      if (!record.project) return prepareIssueProject(input, record, issue, tx);
      if (!input.assessment || !input.title || !input.digest)
        throw new Error('launch-preparation-required');
      return prepareDispatch(input, record, issue, tx);
    }, true);
  });
}
