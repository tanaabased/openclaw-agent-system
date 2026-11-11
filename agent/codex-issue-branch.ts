import { deliveryHasEffects } from './delivery-base.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { gitHubIssueBranchName, gitHubIssueBranchSuffix } from '../tools/git/worktree-names.ts';
import { dispatchGit, type DispatchGit } from './codex-dispatch-project.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';

/** retain branch ownership before native git; callers verify workflow and checkout authority. */
export default async function codexIssueBranch(input: {
  record: DispatchRecord;
  records: DispatchRecord[];
  intake: Pick<IntakeRecord, 'repository' | 'issue'>;
  workspace: string;
  agentId: string;
  save(): Promise<void>;
  git?: DispatchGit;
  signal?: AbortSignal;
  prepare?: boolean;
}) {
  const { record, intake, save, signal } = input;
  if (!record.project || !record.worktree || !record.threadId)
    throw new Error('codex-branch-owner-required');
  const git = input.git ?? dispatchGit;
  const cwd = record.worktree;
  const current = (await git(cwd, ['branch', '--show-current'], signal)).trim();
  const assertAvailable = async (name: string) => {
    if (
      input.records.some(
        (other) =>
          other.id !== record.id &&
          other.project?.commonDir === record.project!.commonDir &&
          (other.issueBranch?.name === name ||
            (other.delivery?.localBranch ?? other.delivery?.binding.branch) === name),
      )
    )
      throw new Error('codex-branch-owner-mismatch');
    await git(cwd, ['check-ref-format', `refs/heads/${name}`], signal);
  };
  const delivery = record.delivery;
  const bound = deliveryHasEffects(delivery);
  if (delivery && bound) {
    const { binding } = delivery;
    if (
      binding.repositoryId !== intake.repository.nodeId ||
      binding.issueId !== intake.issue.nodeId ||
      binding.threadId !== record.threadId ||
      binding.worktree !== cwd ||
      (!input.prepare &&
        current !== (delivery.localBranch ?? record.issueBranch?.name ?? binding.branch))
    )
      throw new Error('codex-branch-owner-mismatch');
  }
  // Git already identifies a named branch in the verified checkout. Keep an outstanding
  // automatic branch creation on its original attempt, and honor existing effect custody.
  if (
    current &&
    (!record.issueBranch ||
      record.issueBranch.phase === 'ready' ||
      (record.issueBranch.phase === 'creating' && record.issueBranch.name === current))
  ) {
    if (record.issueBranch && record.issueBranch.attemptId !== record.id)
      throw new Error('codex-branch-owner-mismatch');
    await assertAvailable(current);
    if (
      input.prepare &&
      !bound &&
      (record.issueBranch?.name !== current || record.issueBranch?.phase !== 'ready')
    ) {
      record.issueBranch = { attemptId: record.id, name: current, phase: 'ready' };
      await save();
    }
    return current;
  }
  if (!record.issueBranch) {
    if (
      !input.prepare ||
      (await git(cwd, ['rev-parse', 'HEAD'], signal)).trim() !== record.project.commit ||
      (await git(cwd, ['status', '--porcelain=v1'], signal)).trim()
    )
      throw new Error('codex-branch-owner-required');
    const name = gitHubIssueBranchName(
      intake.issue.number,
      JSON.parse(record.context ?? '{}').title ?? 'issue',
      gitHubIssueBranchSuffix(
        input.agentId,
        input.workspace,
        intake.repository.nodeId,
        intake.issue.nodeId,
        record.id,
      ),
    );
    record.issueBranch = { attemptId: record.id, name, phase: 'planned' };
    await save();
  }
  const branch = record.issueBranch;
  if (branch.attemptId !== record.id) throw new Error('codex-branch-owner-mismatch');
  await assertAvailable(branch.name);
  if (branch.phase === 'ready') {
    if (current !== branch.name) throw new Error('codex-branch-owner-mismatch');
    return branch.name;
  }
  if (!input.prepare) throw new Error('codex-branch-preparation-required');
  if (current && (current !== branch.name || branch.phase !== 'creating'))
    throw new Error('codex-branch-owner-mismatch');
  if (
    (await git(cwd, ['rev-parse', 'HEAD'], signal)).trim() !== record.project.commit ||
    (await git(cwd, ['status', '--porcelain=v1'], signal)).trim()
  )
    throw new Error('codex-branch-start-changed');
  if (!current) {
    const ref = `refs/heads/${branch.name}`;
    const refs = await git(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', ref], signal);
    const existing = refs.split('\n').find((line) => line.startsWith(ref + ' '));
    if (existing && (branch.phase !== 'creating' || existing !== `${ref} ${record.project.commit}`))
      throw new Error('codex-branch-ref-occupied');
    if (branch.phase === 'planned') {
      branch.phase = 'creating';
      await save();
    }
    await git(
      cwd,
      existing ? ['switch', branch.name] : ['switch', '-c', branch.name, record.project.commit],
      signal,
    );
  }
  if ((await git(cwd, ['branch', '--show-current'], signal)).trim() !== branch.name)
    throw new Error('codex-branch-owner-mismatch');
  branch.phase = 'ready';
  await save();
  return branch.name;
}
