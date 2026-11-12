import { Type } from 'typebox';

import { gitRemoteIdentity } from '../../../tools/git/worktree-remote.ts';
import type { IssueDeliveryState } from './issue-delivery-state.ts';

export const deliveryBaseSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: '^[^\\s]+$',
});

export function deliveryHasEffects(delivery?: IssueDeliveryState) {
  return Boolean(
    delivery &&
    (delivery.pendingPush ||
      delivery.pushedHead ||
      delivery.creationAttempted ||
      delivery.pullRequest),
  );
}

/** A pending effect retains its original destination even when repository defaults change. */
export function selectDeliveryBase(
  requested: string | undefined,
  repositoryDefault: string,
  retained: string | undefined,
) {
  if (retained !== undefined && requested !== undefined && requested !== retained)
    throw new Error('delivery-base-changed');
  return retained ?? requested ?? repositoryDefault;
}

export async function verifyDeliveryCommits(
  git: (argv: string[]) => Promise<string>,
  base: string,
  head: string,
  fetchFrom?: string,
) {
  const ref = `refs/heads/${base}`;
  const tracking = `refs/remotes/origin/${base}`;
  await git(['check-ref-format', ref]);
  if (fetchFrom) {
    const remote = (await git(['remote', 'get-url', 'origin'])).trim();
    if (gitRemoteIdentity(remote) !== `github.com/${fetchFrom.toLowerCase()}`)
      throw new Error('delivery-push-destination-mismatch');
    await git(['fetch', 'origin', `+${ref}:${tracking}`]);
  }
  const count = Number(await git(['rev-list', '--count', `${tracking}..${head}`]));
  if (!Number.isSafeInteger(count) || count < 1)
    throw new Error('delivery-committed-work-required');
}
