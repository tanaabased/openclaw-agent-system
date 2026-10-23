import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import { gitHubIssueBranchName, gitHubIssueBranchSuffix } from '../tools/git/worktree-names.ts';
import { dispatchGit, type DispatchGit } from './codex-dispatch-project.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';

type BranchIssue = Pick<IntakeRecord, 'repository' | 'issue'>;

function retainedBranch(record: DispatchRecord, intake: BranchIssue): string | undefined {
  if ((record.worktreeAttemptId || record.worktreeBranch) && record.worktreeAttemptId !== record.id)
    throw new Error('dispatch-branch-owner-mismatch');
  if (record.worktreeBranch) return record.worktreeBranch;
  // only older attempts may recover ownership from their own retained delivery.
  const binding = !record.worktreeAttemptId && record.delivery?.binding;
  if (
    binding &&
    binding.repositoryId === intake.repository.nodeId &&
    binding.issueId === intake.issue.nodeId &&
    binding.threadId === record.threadId &&
    binding.worktree === record.worktree
  )
    return binding.branch;
  return undefined;
}

export async function verifyCodexWorkBranch(
  record: DispatchRecord,
  intake: BranchIssue,
  git: DispatchGit = dispatchGit,
  signal?: AbortSignal,
): Promise<string> {
  const branch = retainedBranch(record, intake);
  if (!branch) throw new Error('dispatch-branch-ownership-required');
  if ((await git(record.worktree!, ['branch', '--show-current'], signal)).trim() !== branch)
    throw new Error('dispatch-branch-owner-mismatch');
  return branch;
}

/** save intent before native git so an interrupted creation keeps the same attempt. */
export default async function prepareCodexWorkBranch(input: {
  record: DispatchRecord;
  intake: BranchIssue;
  agentId: string;
  workspace: string;
  save(): Promise<void>;
  git?: DispatchGit;
  signal?: AbortSignal;
}): Promise<string> {
  const { record, intake, agentId, workspace, save, signal } = input;
  const git = input.git ?? dispatchGit;
  if (!record.project || !record.worktree) throw new Error('dispatch-branch-ownership-required');
  const retained = retainedBranch(record, intake);
  const current = (await git(record.worktree, ['branch', '--show-current'], signal)).trim();
  if (retained && current === retained) return retained;
  if (current || record.delivery) throw new Error('dispatch-branch-owner-mismatch');
  if (
    (await git(record.worktree, ['rev-parse', 'HEAD'], signal)).trim() !== record.project.commit ||
    (await git(record.worktree, ['status', '--porcelain=v1'], signal))
  )
    throw new Error('dispatch-branch-base-changed');
  const branch =
    retained ??
    agentId +
      '-' +
      gitHubIssueBranchName(
        intake.issue.number,
        JSON.parse(record.context!).title,
        gitHubIssueBranchSuffix(
          agentId,
          workspace,
          `github-${intake.repository.databaseId}`,
          `issue-${intake.issue.databaseId}`,
          record.id,
        ),
      );
  await git(record.worktree, ['check-ref-format', `refs/heads/${branch}`], signal);
  if (
    await git(
      record.worktree,
      ['for-each-ref', '--format=%(refname)', `refs/heads/${branch}`],
      signal,
    )
  )
    throw new Error('dispatch-branch-exists');
  record.worktreeAttemptId = record.id;
  record.worktreeBranch = branch;
  await save();
  await git(record.worktree, ['switch', '--no-track', '-c', branch, record.project.commit], signal);
  return verifyCodexWorkBranch(record, intake, git, signal);
}
