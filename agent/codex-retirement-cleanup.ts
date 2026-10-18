import { lstat, realpath } from 'node:fs/promises';

import { nativeObject } from './automation-gateway.ts';
import { readCodexAutomations } from './codex-automation-state.ts';
import { dispatchGit, verifyDispatchWorktree, type DispatchGit } from './codex-dispatch-project.ts';
import type { RetirementCleanupResult } from './reconcile-assignment-lifecycle.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';
import type codexRetirementNative from './codex-retirement-native.ts';

export type RetirementArchiveRequest = { threadId: string; archived: true; hostId: 'local' };

/** prepare a native desktop archive once; only observed reclamation finishes retirement. */
export default async function codexRetirementCleanup(input: {
  record: DispatchRecord;
  codexHome: string;
  repository: string;
  archived: boolean;
  inventory: unknown;
  now: number;
  turnId: string;
  native: ReturnType<typeof codexRetirementNative>;
  git?: DispatchGit;
  fresh(): Promise<void>;
  save(): Promise<void>;
}): Promise<RetirementCleanupResult & { request?: RetirementArchiveRequest }> {
  const { record } = input;
  const retirement = record.retirement!;
  const threadId = record.threadId ?? record.receiptThreadId;
  const pending = (code: string) => ({ archived: input.archived, worktreeRemoved: false, code });
  if (!threadId || !record.worktree || !record.project)
    return pending('retirement-native-resource-unresolved');
  const exists = await lstat(record.worktree).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!exists)
    return input.archived
      ? { archived: true, worktreeRemoved: true }
      : pending('retirement-worktree-observation-required');
  if (input.archived) return pending('retirement-native-reclamation-pending');
  if (retirement.archiveAttempt) {
    const outcome = await input.native.archiveOutcome(
      record.sourceThreadId,
      threadId,
      retirement.archiveAttempt,
      input.turnId,
    );
    if (outcome !== 'unsubmitted')
      return pending(
        outcome === 'denied'
          ? 'retirement-native-archive-denied'
          : 'retirement-native-archive-unverified',
      );
    delete retirement.archiveAttempt;
    await input.save();
  }
  const inventory = input.inventory;
  if (
    !nativeObject(inventory) ||
    inventory.schemaVersion !== 4 ||
    !Array.isArray(inventory.pinnedThreads) ||
    !Array.isArray(inventory.unavailableHosts) ||
    inventory.unavailableHosts.some((host) => typeof host !== 'string' || host === 'local') ||
    !Array.isArray(inventory.unavailableSources) ||
    inventory.unavailableSources.some((source) => typeof source !== 'string' || source === 'codex')
  )
    return pending('retirement-native-inventory-required');
  if (inventory.pinnedThreads.some((entry) => !nativeObject(entry) || entry.id === threadId))
    return pending('retirement-native-resource-protected');
  const jobs = await readCodexAutomations(input.codexHome);
  if (
    jobs.some(
      (job) =>
        ('targetThreadId' in job.definition && job.definition.targetThreadId === threadId) ||
        job.cwds?.includes(record.worktree!),
    )
  )
    return pending('retirement-automation-owner');
  if ((await input.native.worktreeUsers(record.worktree)).some((id) => id !== threadId))
    return pending('retirement-worktree-shared');
  if (
    exists.isSymbolicLink() ||
    !exists.isDirectory() ||
    (await realpath(record.worktree)) !== record.worktree
  )
    return pending('retirement-native-resource-protected');
  const git = input.git ?? dispatchGit;
  await verifyDispatchWorktree(record.project, record.worktree, input.repository, git, 'handoff');
  if (await git(record.worktree, ['status', '--porcelain=v1', '--untracked-files=all']))
    return pending('retirement-worktree-dirty');
  const head = await git(record.worktree, ['rev-parse', 'HEAD']);
  if (
    !/^[a-f0-9]{40,64}$/u.test(head) ||
    !(
      await git(record.worktree, [
        'for-each-ref',
        '--format=%(refname)',
        '--contains=' + head,
        'refs/heads/',
        'refs/remotes/',
        'refs/tags/',
      ])
    ).trim()
  )
    return pending('retirement-worktree-unpreserved');
  await input.fresh();
  retirement.archiveAttempt = { at: input.now, turnId: input.turnId };
  await input.save();
  return {
    ...pending('retirement-native-archive-pending'),
    request: { threadId, archived: true, hostId: 'local' } satisfies RetirementArchiveRequest,
  };
}
