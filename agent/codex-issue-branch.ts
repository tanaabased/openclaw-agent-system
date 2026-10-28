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
  if (!record.issueBranch) {
    const delivery = record.delivery?.pullRequest ? record.delivery.binding : undefined;
    if (delivery) {
      if (
        delivery.repositoryId !== intake.repository.nodeId ||
        delivery.issueId !== intake.issue.nodeId ||
        delivery.threadId !== record.threadId ||
        delivery.worktree !== cwd
      )
        throw new Error('codex-branch-owner-required');
      record.issueBranch = {
        attemptId: record.id,
        name: record.delivery?.localBranch ?? delivery.branch,
        phase: 'ready',
      };
    } else {
      if (
        !input.prepare ||
        current ||
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
    }
    await save();
  }
  const branch = record.issueBranch;
  if (
    branch.attemptId !== record.id ||
    input.records.some(
      (other) =>
        other.id !== record.id &&
        other.project?.commonDir === record.project!.commonDir &&
        (other.issueBranch?.name === branch.name ||
          (other.delivery?.localBranch ?? other.delivery?.binding.branch) === branch.name),
    )
  )
    throw new Error('codex-branch-owner-mismatch');
  await git(cwd, ['check-ref-format', `refs/heads/${branch.name}`], signal);
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
