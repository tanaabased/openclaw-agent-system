import type { ImplementationSource } from './implementation-revision.ts';
import { automationHash } from './automation-hash.ts';
import type { CodexWorkContext } from './codex-continuation-context.ts';
import type { DispatchNativeThread } from './codex-dispatch-native.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import implementationHandoff from './implementation-handoff.ts';
import { implementationPresentation } from './implementation-result.ts';
import { validateWorkflowResult } from './workflow-result.ts';

/** Record implementation output after the controller verifies the current native owner. */
export default async function recordCodexWorkResult(
  record: DispatchRecord,
  context: Pick<CodexWorkContext, 'input' | 'git' | 'signal' | 'save'>,
  found: Pick<DispatchNativeThread, 'cwd'> & { turnId: string },
  revisionInput?: ImplementationSource,
) {
  const { input, git, signal, save } = context;
  const work = record.continuation!;
  if (work.publicationAttempt) throw new Error('continuation-implementation-already-recorded');
  if (!input.result) throw new Error('continuation-result-required');
  validateWorkflowResult(
    {
      version: 1,
      stage: 'implementation',
      resultContract: 'implementation-result/v1',
      binding: work.binding!,
      result: { outcome: input.result.outcome, summary: input.result.summary },
    },
    { stage: 'implementation', authorized: true, binding: work.binding! },
  );
  if (
    work.result &&
    work.result.outcome !== 'clarification-needed' &&
    !(work.result.outcome === 'blocked' && work.phase === 'running') &&
    automationHash(work.result) !== automationHash(input.result)
  )
    throw new Error('continuation-result-conflict');
  if (input.result.outcome === 'done') {
    if ((await git(found.cwd, ['status', '--porcelain=v1'], signal)).trim())
      throw new Error('continuation-uncommitted-work');
    const head = (await git(found.cwd, ['rev-parse', '--verify', 'HEAD'], signal)).trim();
    if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('continuation-head-invalid');
    work.head = head;
  }
  if (work.result?.outcome !== 'done')
    work.resultSource = work.revisionSource ??
      revisionInput ?? {
        turnId: found.turnId,
        inputId: work.attempt?.inputId ?? found.turnId,
      };
  work.result = input.result;
  delete work.revisionSource;
  delete work.code;
  if (input.result.outcome === 'blocked') work.blockedTurnId = found.turnId;
  else delete work.blockedTurnId;
  work.phase =
    input.result.outcome === 'done'
      ? work.scope === 'local'
        ? 'complete'
        : 'delivery'
      : input.result.outcome === 'clarification-needed'
        ? 'clarification-needed'
        : 'blocked';
  if (input.result.outcome === 'clarification-needed') work.clarificationTurnId = found.turnId;
  else delete work.clarificationTurnId;
  await save();
  return {
    status: 'recorded' as const,
    id: record.id,
    outcome: input.result.outcome,
    next: work.phase,
    handoff: implementationHandoff(
      record.id,
      input.result.outcome,
      'codex',
      work.scope === 'local' ? { publication: false } : undefined,
      Boolean(record.adoptedPullRequest),
    ),
    presentation: implementationPresentation(input.result),
  };
}
