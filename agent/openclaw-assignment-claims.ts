import recoverAssignmentClaim from './assignment-claim-recovery.ts';
import source from './assignment-claim-source.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import type {
  GitHubNotificationIntakeClient,
  GitHubNotificationItemContextClient,
} from '../channels/github/provider/work-event-types.ts';
import { acceptAssignmentClaim, claimAssignment, type ClaimClient } from './assignment-claim.ts';
import type AssignmentClaimStore from './assignment-claim-store.ts';
import { automationHash } from './automation-hash.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type { DispatchCaller } from './openclaw-session-create.ts';

type Connection = GitHubNotificationIntakeClient & GitHubNotificationItemContextClient;

/** native occurrences own the wait; verified session receipts own acceptance. */
export default class OpenClawAssignmentClaims {
  constructor(
    readonly store: AssignmentClaimStore,
    readonly connect: (connection: Connection) => ClaimClient,
  ) {}

  select(input: {
    intake: IntakeRecord;
    client: Connection;
    caller: DispatchCaller;
    hasCapacity: boolean;
  }) {
    const { sessionKey, sessionId, runId } = input.caller;
    return claimAssignment({
      store: this.store,
      client: this.connect(input.client),
      source: source(input.intake),
      passId: automationHash({ sessionKey, sessionId, runId }),
      hasCapacity: input.hasCapacity,
    });
  }

  recover(
    intake: IntakeRecord,
    client: Connection,
    record: OpenClawDispatchRecord,
    recoveryId: string,
    operation: 'preview' | 'reserve' | 'accept',
    successorReceipt?: string,
  ) {
    const receipt = record.sessionCreation?.sessionId;
    if (!receipt) throw new Error('claim-native-creation-unverified');
    return recoverAssignmentClaim({
      store: this.store,
      client: this.connect(client),
      source: source(intake),
      recoveryId,
      predecessorReceipt: receipt,
      operation,
      successorReceipt,
    });
  }

  accept(intake: IntakeRecord, client: Connection, record: OpenClawDispatchRecord) {
    if (!record.sessionCreation?.verified || !record.sessionCreation.sessionId || !record.threadId)
      throw new Error('claim-native-creation-unverified');
    return acceptAssignmentClaim({
      store: this.store,
      client: this.connect(client),
      source: source(intake),
      nativeReceipt: record.sessionCreation.sessionId,
    });
  }
}
