import { assignmentClaimKey, type ClaimClient, type ClaimSource } from './assignment-claim.ts';
import type AssignmentClaimStore from './assignment-claim-store.ts';
import { claimBody, parseAssignmentClaim } from '../channels/github/provider/assignment-claim.ts';

/** transfer only an exact accepted claim in this installation; no election or provider mutation. */
export default async function recoverAssignmentClaim(input: {
  store: AssignmentClaimStore;
  client: ClaimClient;
  source: ClaimSource;
  recoveryId: string;
  predecessorReceipt: string;
  operation: 'preview' | 'reserve' | 'accept';
  successorReceipt?: string;
}) {
  return input.store.exclusive(async (state, save) => {
    await input.client.verify(input.source);
    const claims = (await input.client.list(input.source))
      .filter(
        (comment) =>
          comment.author?.nodeId === input.source.receivingNodeId &&
          parseAssignmentClaim(comment)?.assignmentEventId === input.source.assignmentEventId,
      )
      .sort((a, b) => a.databaseId - b.databaseId);
    const record = state.claims[assignmentClaimKey(input.source)];
    if (!record && !claims.length) return undefined;
    const winner = claims[0];
    if (
      !record ||
      record.instanceId !== state.instanceId ||
      !record.nativeReceipt ||
      !winner ||
      record.winnerId !== record.commentId ||
      winner.databaseId !== record.commentId ||
      parseAssignmentClaim(winner)?.instanceId !== state.instanceId ||
      record.cleanupPending ||
      winner.body !== claimBody(parseAssignmentClaim(winner)!, state.displayName, true)
    )
      throw new Error('claim-recovery-owner-unresolved');
    if (
      record.recovery &&
      (record.recovery.id !== input.recoveryId ||
        record.recovery.predecessorReceipt !== input.predecessorReceipt)
    )
      throw new Error('claim-recovery-owner-unresolved');
    if (
      record.nativeReceipt !== input.predecessorReceipt &&
      !(
        input.operation === 'accept' &&
        record.recovery?.successorReceipt === input.successorReceipt &&
        record.nativeReceipt === input.successorReceipt
      )
    )
      throw new Error('claim-native-receipt-conflict');
    if (input.operation === 'accept' && !record.recovery)
      throw new Error('claim-recovery-reservation-required');
    if (input.operation !== 'preview') {
      record.recovery ??= { id: input.recoveryId, predecessorReceipt: input.predecessorReceipt };
      if (input.operation === 'accept') {
        if (!input.successorReceipt) throw new Error('claim-native-creation-unverified');
        if (
          record.recovery.successorReceipt &&
          record.recovery.successorReceipt !== input.successorReceipt
        )
          throw new Error('claim-native-receipt-conflict');
        record.recovery.successorReceipt = input.successorReceipt;
        record.nativeReceipt = input.successorReceipt;
      }
      await save();
    }
    return {
      commentId: record.commentId,
      instanceId: record.instanceId,
      predecessorReceipt: input.predecessorReceipt,
      body: winner.body,
    };
  });
}
