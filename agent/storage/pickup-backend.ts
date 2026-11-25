import { assignmentClaimLockPath } from './workflow-lock.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';
import IssuePickupEnrollmentStore from '../issue-pickup-enrollment.ts';
import AssignmentClaimStore from '../tasks/dispatch/assignment-claim-store.ts';
import { bindAgentStore } from './backend.ts';
import type { SqliteInstallation } from './storage-lifecycle.ts';

export function bindInstanceStore(installation: SqliteInstallation) {
  const root = installation.installationRoot;
  const database = async () =>
    (await import('./agent-database.ts')).bindSqliteInstallation(installation);
  return new AssignmentClaimStore({
    lockPath: assignmentClaimLockPath(root),
    async read() {
      const db = await database();
      const rows = await db
        .read({ instances: {}, assignmentClaims: {} })
        .catch((error: unknown) => {
          if (nodeErrorCode(error) !== 'ENOENT') throw error;
          return undefined;
        });
      if (!rows) return undefined;
      const { instances, assignmentClaims } = rows;
      if (!instances.length && !assignmentClaims.length) return undefined;
      const row = instances[0];
      if (instances.length !== 1 || !row || row.id !== row.value?.instanceId)
        throw new Error('assignment-claim-state-invalid');
      return {
        ...row.value,
        claims: Object.fromEntries(assignmentClaims.map(({ id, value }) => [id, value])),
      };
    },
    async save(state, saved) {
      const db = await database();
      await db.saveAssignmentClaims(state, saved);
    },
  });
}

export async function bindPickupStore(installation: SqliteInstallation, agentId: string) {
  const agent = await bindAgentStore(agentId, installation);
  return new IssuePickupEnrollmentStore(bindInstanceStore(installation), { agent, agentId });
}
