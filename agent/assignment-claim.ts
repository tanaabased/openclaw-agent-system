import { createHash } from 'node:crypto';

import { claimBody, parseAssignmentClaim } from '../channels/github/provider/assignment-claim.ts';
import type { GitHubCanonicalIssueComment } from '../channels/github/provider/comment-admission.ts';
import type AssignmentClaimStore from './assignment-claim-store.ts';

export interface ClaimSource {
  repositoryNodeId: string;
  owner: string;
  repository: string;
  issueNodeId: string;
  number: number;
  receivingNodeId: string;
  assignmentEventId: string;
  assignerNodeId: string;
}

export interface ClaimClient {
  verify(source: ClaimSource): Promise<void>;
  list(source: ClaimSource): Promise<GitHubCanonicalIssueComment[]>;
  create(source: ClaimSource, body: string): Promise<number>;
  update(source: ClaimSource, commentId: number, previousBody: string, body: string): Promise<void>;
  remove(source: ClaimSource, commentId: number, previousBody: string): Promise<void>;
}

export function assignmentClaimKey(source: ClaimSource) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        source.repositoryNodeId,
        source.issueNodeId,
        source.receivingNodeId,
        source.assignmentEventId,
      ]),
    )
    .digest('hex');
}

export interface ClaimDecision {
  status: 'local' | 'pending' | 'owned' | 'other-owner' | 'recovery-required' | 'at-capacity';
  code?: string;
  winnerId?: number;
}

/** a local route must not bypass a visible election or initialize an installation identity. */
export async function selectAssignmentClaim(
  input: Parameters<typeof claimAssignment>[0] & {
    mode: 'local' | 'swarm' | 'deny';
  },
): Promise<ClaimDecision> {
  if (input.mode === 'deny') throw new Error('claim-route-denied');
  if (input.mode === 'swarm') return claimAssignment(input);
  await input.store.assertUnclaimed(assignmentClaimKey(input.source));
  await input.client.verify(input.source);
  const claims = await readAssignmentClaims(input.client, input.source);
  if (claims.length)
    return {
      status: 'recovery-required',
      code: 'claim-route-conflict',
      winnerId: claims[0]!.comment.databaseId,
    };
  return { status: 'local' };
}

export async function readAssignmentClaims(client: ClaimClient, source: ClaimSource) {
  const comments = await client.list(source);
  const claims = comments
    .filter((comment) => comment.author?.nodeId === source.receivingNodeId)
    .map((comment) => {
      const claim = parseAssignmentClaim(comment);
      // unknown or damaged control metadata cannot establish that this work is unclaimed.
      if (
        !claim &&
        /^Assignment (?:claim registered|accepted) on `/u.test(comment.body) &&
        comment.body.includes('<!-- agent-system-claim:')
      )
        throw new Error('claim-metadata-unresolved');
      return { comment, claim };
    });
  return claims
    .filter(({ claim }) => claim?.assignmentEventId === source.assignmentEventId)
    .sort((a, b) => a.comment.databaseId - b.comment.databaseId);
}

/** two passes reduce ordinary contention; provider omissions are a documented recovery risk. */
export async function claimAssignment(input: {
  store: AssignmentClaimStore;
  client: ClaimClient;
  source: ClaimSource;
  passId: string;
  hasCapacity: boolean;
}): Promise<ClaimDecision> {
  const { store, client, source, passId } = input;
  if (!passId) throw new Error('claim-pass-required');
  return store.exclusive(async (state, save, signal) => {
    signal.throwIfAborted();
    await client.verify(source);
    const claims = await readAssignmentClaims(client, source);
    let record = state.claims[assignmentClaimKey(source)];
    if (record && record.instanceId !== state.instanceId)
      return { status: 'recovery-required', code: 'claim-instance-rotated' };
    if (record?.recovery) return { status: 'recovery-required', code: 'claim-recovery-reserved' };
    const retainedWinner = record?.winnerId;
    if (retainedWinner && !claims.some(({ comment }) => comment.databaseId === retainedWinner))
      return { status: 'recovery-required', code: 'claim-winner-missing' };
    if (retainedWinner && claims[0]?.comment.databaseId !== retainedWinner)
      return { status: 'recovery-required', code: 'claim-winner-changed' };
    if (!record) {
      if (claims.length) {
        state.claims[assignmentClaimKey(source)] = {
          instanceId: state.instanceId,
          firstPass: passId,
          attempted: false,
          winnerId: claims[0]!.comment.databaseId,
        };
        await save();
        return { status: 'other-owner', winnerId: claims[0]!.comment.databaseId };
      }
      if (!input.hasCapacity) return { status: 'at-capacity' };
      record = {
        instanceId: state.instanceId,
        firstPass: passId,
        attempted: true,
      };
      state.claims[assignmentClaimKey(source)] = record;
      await save();
      await client.verify(source);
      signal.throwIfAborted();
      record.commentId = await client.create(
        source,
        claimBody(
          {
            instanceId: state.instanceId,
            assignmentEventId: source.assignmentEventId,
          },
          state.displayName,
        ),
      );
      await save();
      return { status: 'pending' };
    }
    if (!record.attempted) return { status: 'other-owner', winnerId: record.winnerId };
    if (record.firstPass === passId) return { status: 'pending' };
    if (!record.commentId) {
      record.commentId = claims.find(({ claim }) => claim!.instanceId === record.instanceId)
        ?.comment.databaseId;
      if (!record.commentId)
        return { status: 'recovery-required', code: 'claim-publication-unconfirmed' };
      await save();
    }
    const winner = claims[0];
    if (!winner) return { status: 'recovery-required', code: 'claim-comment-missing' };
    if (record.winnerId && record.winnerId !== winner.comment.databaseId)
      return { status: 'recovery-required', code: 'claim-winner-changed' };
    record.winnerId = winner.comment.databaseId;
    await save();
    const own = claims.find(({ comment }) => comment.databaseId === record.commentId);
    if (winner.claim!.instanceId !== state.instanceId) {
      if (own) {
        if (own.claim!.instanceId !== state.instanceId)
          return { status: 'recovery-required', code: 'claim-comment-changed' };
        record.cleanupPending = true;
        await save();
        try {
          await client.verify(source);
          signal.throwIfAborted();
          await client.remove(source, own.comment.databaseId, own.comment.body);
        } catch {
          return {
            status: 'other-owner',
            winnerId: record.winnerId,
            code: 'claim-cleanup-pending',
          };
        }
        record.cleaned = true;
        record.cleanupPending = false;
        await save();
      } else if (!record.cleaned && !record.cleanupPending) {
        return { status: 'recovery-required', code: 'claim-comment-missing' };
      } else if (record.cleanupPending) {
        record.cleaned = true;
        record.cleanupPending = false;
        await save();
      }
      return { status: 'other-owner', winnerId: record.winnerId };
    }
    if (!own || own.claim!.instanceId !== state.instanceId)
      return { status: 'recovery-required', code: 'claim-comment-changed' };
    if (record.commentId !== record.winnerId)
      return { status: 'recovery-required', code: 'claim-identity-shared' };
    if (!input.hasCapacity) return { status: 'at-capacity' };
    await client.verify(source);
    signal.throwIfAborted();
    return { status: 'owned', winnerId: record.winnerId };
  });
}

/** the native adapter must verify creation before supplying this receipt. */
export async function acceptAssignmentClaim(input: {
  store: AssignmentClaimStore;
  client: ClaimClient;
  source: ClaimSource;
  nativeReceipt: string;
}) {
  if (!input.nativeReceipt) throw new Error('claim-native-receipt-required');
  return input.store.exclusive(async (state, save, signal) => {
    const record = state.claims[assignmentClaimKey(input.source)];
    if (
      !record ||
      record.instanceId !== state.instanceId ||
      record.commentId !== record.winnerId ||
      !record.commentId
    )
      throw new Error('claim-owner-required');
    if (record.recovery && record.recovery.successorReceipt !== input.nativeReceipt)
      throw new Error('claim-recovery-reserved');
    if (record.nativeReceipt && record.nativeReceipt !== input.nativeReceipt)
      throw new Error('claim-native-receipt-conflict');
    record.nativeReceipt = input.nativeReceipt;
    await save();
    await input.client.verify(input.source);
    const comments = (await readAssignmentClaims(input.client, input.source)).map(
      ({ comment }) => comment,
    );
    const winner = comments[0];
    if (winner?.databaseId !== record.winnerId) throw new Error('claim-winner-changed');
    const current = comments.find((comment) => comment.databaseId === record.commentId);
    const metadata = current && parseAssignmentClaim(current);
    if (
      !current ||
      current.author?.nodeId !== input.source.receivingNodeId ||
      metadata?.instanceId !== state.instanceId ||
      metadata.assignmentEventId !== input.source.assignmentEventId
    )
      throw new Error('claim-comment-changed');
    const body = claimBody(metadata, state.displayName, true);
    signal.throwIfAborted();
    if (current.body !== body)
      await input.client.update(input.source, current.databaseId, current.body, body);
  });
}
