import { lstat, realpath } from 'node:fs/promises';

import { nativeObject } from '../../../utils/native-object.ts';
import { readCodexAutomations } from '../../automations/codex-automation-state.ts';
import {
  dispatchGit,
  verifyDispatchWorktree,
  type DispatchGit,
} from '../dispatch/codex-dispatch-project.ts';
import type { RetirementCleanupResult } from '../dispatch/reconcile-assignment-lifecycle.ts';
import type { DispatchRecord } from '../dispatch/codex-dispatch-state.ts';
import type codexRetirementNative from './codex-retirement-native.ts';

export type RetirementArchiveRequest = { threadId: string; archived: true; hostId: 'local' };

/** prepare a native desktop archive once; only observed reclamation finishes retirement. */
export default async function codexRetirementCleanup(input: {
  record: DispatchRecord;
  shared?: readonly DispatchRecord[];
  codexHome: string;
  repository: string;
  archived: boolean;
  issueClosed?: boolean;
  inventory: unknown;
  now: number;
  turnId: string;
  sourceThreadId?: string;
  native: ReturnType<typeof codexRetirementNative>;
  git?: DispatchGit;
  fresh(): Promise<void>;
  save(): Promise<void>;
}): Promise<RetirementCleanupResult & { request?: RetirementArchiveRequest }> {
  const { record } = input;
  const worktree = record.worktree;
  const retirement = record.retirement!;
  const discard = input.issueClosed || Boolean(retirement.operatorRequest);
  const threadId = record.threadId ?? record.receiptThreadId;
  const pending = (code: string) => ({ archived: input.archived, worktreeRemoved: false, code });
  const projectless = record.reviewAdmission && record.request?.target.type === 'projectless';
  if (!threadId || (!projectless && (!worktree || !record.project)))
    return pending('retirement-native-resource-unresolved');
  const exists = worktree
    ? await lstat(worktree).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      })
    : undefined;
  if (!exists && (input.archived || !projectless))
    return input.archived
      ? { archived: true, worktreeRemoved: true }
      : pending('retirement-worktree-observation-required');
  if (input.archived) return pending('retirement-native-reclamation-pending');
  if (retirement.archiveAttempt) {
    const outcome = await input.native.archiveOutcome(
      retirement.archiveAttempt.sourceThreadId ?? record.sourceThreadId,
      threadId,
      retirement.archiveAttempt,
      (retirement.archiveAttempt.sourceThreadId ?? record.sourceThreadId) ===
        (input.sourceThreadId ?? record.sourceThreadId)
        ? input.turnId
        : undefined,
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
  const owners = new Set([threadId]);
  for (const other of input.shared ?? []) {
    const id = other.threadId ?? other.receiptThreadId;
    if (!id) return pending('retirement-native-resource-unresolved');
    owners.add(id);
  }
  if (inventory.pinnedThreads.some((entry) => !nativeObject(entry) || typeof entry.id !== 'string'))
    return pending('retirement-native-inventory-required');
  if (
    !discard &&
    inventory.pinnedThreads.some((entry) =>
      owners.has(String((entry as Record<string, unknown>).id)),
    )
  )
    return pending('retirement-native-resource-protected');
  const jobs = await readCodexAutomations(input.codexHome);
  if (
    jobs.some(
      (job) =>
        ('targetThreadId' in job.definition && owners.has(String(job.definition.targetThreadId))) ||
        (worktree && job.cwds?.includes(worktree)),
    )
  )
    return pending('retirement-automation-owner');
  if (worktree && record.project) {
    const protectedThreads = new Set(
      discard
        ? []
        : inventory.pinnedThreads.map((entry) => String((entry as Record<string, unknown>).id)),
    );
    for (const job of jobs)
      if ('targetThreadId' in job.definition)
        protectedThreads.add(String(job.definition.targetThreadId));
    const worktreeUsers = await input.native.worktreeUsers(worktree, owners, protectedThreads, {
      allowEndedHelpers: discard,
    });
    if (worktreeUsers.some((id) => !owners.has(id))) return pending('retirement-worktree-shared');
    if (
      !exists ||
      exists.isSymbolicLink() ||
      !exists.isDirectory() ||
      (await realpath(worktree)) !== worktree
    )
      return pending('retirement-native-resource-protected');
    const git = input.git ?? dispatchGit;
    await verifyDispatchWorktree(record.project, worktree, input.repository, git, 'handoff');
    if (!discard && (await git(worktree, ['status', '--porcelain=v1', '--untracked-files=all'])))
      return pending('retirement-worktree-dirty');
    if (!discard) {
      const head = await git(worktree, ['rev-parse', 'HEAD']);
      if (
        !/^[a-f0-9]{40,64}$/u.test(head) ||
        !(
          await git(worktree, [
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
    }
  }
  await input.fresh();
  if (record.worktree !== worktree) return pending('retirement-observation-changed');
  retirement.archiveAttempt = {
    at: input.now,
    turnId: input.turnId,
    ...(input.sourceThreadId ? { sourceThreadId: input.sourceThreadId } : {}),
  };
  await input.save();
  return {
    ...pending('retirement-native-archive-pending'),
    request: { threadId, archived: true, hostId: 'local' } satisfies RetirementArchiveRequest,
  };
}
