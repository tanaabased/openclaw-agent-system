import { automationHash } from './automation-hash.ts';
import type { SharedDispatchRecord } from './dispatch-state.ts';
import type { ManagedIssue } from './managed-issue.ts';
import type { AdoptedPullRequest } from './delivery-state.ts';

function recoveryBlockers(
  record: SharedDispatchRecord,
  effects: Record<string, boolean | undefined>,
) {
  return Object.entries({
    nativeTaskMissing: !record.threadId || !record.worktree || !record.request,
    assessmentMissing: !record.result,
    inactiveLifecycle: Boolean(record.reset || record.retired || record.retirement),
    uncertainAssessmentSummary: record.assessmentSummaries?.some(
      (summary) => summary.attempt && !summary.receipt,
    ),
    ...effects,
  })
    .filter(([, blocked]) => blocked)
    .map(([name]) => name);
}

/** the caller holds its native dispatch lock; adapters supply authority and effect observations. */
export default async function recoverIssueTask<R extends SharedDispatchRecord>(input: {
  record: R;
  state: { records: R[] };
  intake: ManagedIssue;
  caller: string;
  operator: { turnId: string; inputId: string };
  manifestDigest: string;
  issueUrl: string;
  now: number;
  digest?: unknown;
  mode?: 'plan' | 'work' | 'auto';
  effects: Record<string, boolean | undefined>;
  revalidate(): Promise<unknown>;
  fresh(): Promise<void>;
  save(): Promise<void>;
  observe(): Promise<unknown>;
  operatorInput(): Promise<{ turnId: string; inputId: string }>;
  adopt(): Promise<AdoptedPullRequest>;
  claim?(operation: 'preview' | 'reserve'): Promise<unknown>;
  create(record: Omit<SharedDispatchRecord, 'request'>): R;
}) {
  const {
    record,
    state,
    intake,
    caller,
    operator,
    manifestDigest,
    issueUrl,
    now,
    effects,
    revalidate,
    fresh,
    save,
    observe,
    operatorInput,
    adopt,
    create,
  } = input;
  if (state.records.some((entry) => entry.threadId === caller))
    throw new Error('dispatch-operator-caller-required');
  if (
    state.records.some(
      (entry) =>
        entry.id !== record.id &&
        entry.issueKey === record.issueKey &&
        !entry.supersededBy &&
        !entry.reset &&
        !entry.retired &&
        entry.predecessorId !== record.id,
    )
  )
    throw new Error('dispatch-recovery-competing-owner');
  if (record.supersededBy) {
    const successor = state.records.find(
      (entry) => entry.id === record.supersededBy && entry.predecessorId === record.id,
    );
    if (!successor) throw new Error('dispatch-recovery-owner-missing');
    return {
      status: 'recovery-ready',
      id: record.id,
      successorId: successor.id,
      launch: { action: 'launch', operation: 'context', target: issueUrl, id: successor.id },
      instruction:
        'Continue this retained successor through Task Launch; reconcile its prepared native request without creating another successor.',
    };
  }
  await revalidate();
  const blockers = recoveryBlockers(record, effects);
  if (blockers.length)
    return {
      status: 'blocked',
      id: record.id,
      code: 'dispatch-recovery-effects-unresolved',
      blockers,
      instruction:
        'Resolve these reported prerequisites through their original native or publication owners before replacement. Preserve native denials and all work; no successor was reserved.',
    };
  const native = await observe();
  const adopted = await adopt();
  const id = automationHash([record.id, 'recovery']);
  const claim = await input.claim?.('preview');
  const digest = automationHash({ record, operator, native, adopted, manifestDigest, id, claim });
  await fresh();
  if (input.digest === undefined)
    return {
      status: 'recovery-available',
      id: record.id,
      digest,
      successorId: id,
      issue: issueUrl,
      pullRequest: adopted,
      preserved: { threadId: record.threadId, worktree: record.worktree },
      instruction:
        'Approve this exact replacement with its digest. Preserve old work and history; supersede only this installation’s managed task. No remote computer is disabled and no PR is published.',
    };
  if (input.digest !== digest) throw new Error('dispatch-recovery-stale');
  const latest = await observe();
  const latestOperator = await operatorInput();
  if (
    automationHash(latest) !== automationHash(native) ||
    latestOperator.turnId !== operator.turnId ||
    latestOperator.inputId !== operator.inputId
  )
    throw new Error('dispatch-recovery-stale');
  if (automationHash(await adopt()) !== automationHash(adopted))
    throw new Error('dispatch-recovery-stale');
  await input.claim?.('reserve');
  await fresh();
  const manualIssue = {
    version: 1 as const,
    id,
    scope: intake.scope,
    receiving: intake.receiving,
    workspaceDir: intake.workspaceDir,
    agentId: intake.agentId,
    host: intake.host,
    repository: intake.repository,
    issue: intake.issue,
    initiation: {
      kind: 'operator' as const,
      session: caller,
      incarnation: caller,
      turn: operator.turnId,
      input: operator.inputId,
    },
    selections: {
      ...record.manualIssue?.selections,
      routing:
        record.manualIssue?.selections?.routing ??
        (record.routing ? JSON.parse(record.routing).selection : undefined),
    },
    ...(record.manualIssue?.fresh ? { fresh: true as const } : {}),
    evidence: {
      policyDigest: manifestDigest,
      mode: input.mode ?? record.manualIssue?.selections?.mode ?? intake.evidence.mode,
      open: true as const,
      repositoryReadable: true as const,
    },
    observedAt: now,
    admittedAt: now,
    status: 'admitted' as const,
    requiresRevalidation: true as const,
  };
  state.records.push(
    create({
      id,
      manualIssue,
      issueKey: record.issueKey,
      sourceThreadId: caller,
      phase: 'routing',
      createdAt: now,
      manifestDigest,
      context: record.context,
      predecessorId: record.id,
      adoptedPullRequest: adopted,
    }),
  );
  record.supersededBy = id;
  record.recovery = {
    digest,
    by: caller,
    turnId: operator.turnId,
    inputId: operator.inputId,
    at: now,
  };
  await save();
  return {
    status: 'recovery-ready',
    id: record.id,
    successorId: id,
    launch: { action: 'launch', operation: 'context', target: issueUrl, id },
    instruction:
      'Use Task Launch with this exact successor id, then prepare and reconcile its one native creation. Old chat, checkout, commits and assessment remain evidence; the old managed task cannot resume.',
  };
}
