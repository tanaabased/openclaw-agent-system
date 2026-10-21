import { join } from 'node:path';

import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import GitHubAssignmentClaimClient from '../channels/github/provider/assignment-claim-client.ts';
import GitHubWorkEventClient from '../channels/github/provider/work-event-client.ts';
import { acceptAssignmentClaim, claimAssignment, type ClaimClient } from './assignment-claim.ts';
import source from './assignment-claim-source.ts';
import AssignmentClaimStore from './assignment-claim-store.ts';
import { automationHash } from './automation-hash.ts';
import type { revalidateDispatchAssignment } from './codex-dispatch-context.ts';
import type { DispatchRecord } from './codex-dispatch-state.ts';

type Connection = Awaited<ReturnType<typeof revalidateDispatchAssignment>>['client'];

export default class CodexAssignmentClaims {
  constructor(
    readonly store: AssignmentClaimStore,
    readonly connect: (connection: Connection) => ClaimClient = (connection) => {
      if (!(connection instanceof GitHubWorkEventClient))
        throw new Error('claim-provider-binding-required');
      return new GitHubAssignmentClaimClient(connection);
    },
  ) {}

  select(input: {
    intake: IntakeRecord;
    client: Connection;
    threadId: string;
    turnId: string;
    hasCapacity: boolean;
  }) {
    return claimAssignment({
      store: this.store,
      client: this.connect(input.client),
      source: source(input.intake),
      passId: automationHash({ threadId: input.threadId, turnId: input.turnId }),
      hasCapacity: input.hasCapacity,
    });
  }

  accept(intake: IntakeRecord, client: Connection, record: DispatchRecord) {
    if (!record.effective || !record.threadId || !record.worktree)
      throw new Error('claim-native-creation-unverified');
    return acceptAssignmentClaim({
      store: this.store,
      client: this.connect(client),
      source: source(intake),
      nativeReceipt: record.threadId,
    });
  }
}

export function codexInstanceStore(pluginData: string) {
  return new AssignmentClaimStore(join(pluginData, 'instance'));
}
