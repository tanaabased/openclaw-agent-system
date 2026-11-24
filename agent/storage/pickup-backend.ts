import nodeErrorCode from '../../utils/node-error-code.ts';
import { isDeepStrictEqual } from 'node:util';
import IssuePickupEnrollmentStore from '../issue-pickup-enrollment.ts';
import AssignmentClaimStore from '../tasks/dispatch/assignment-claim-store.ts';
import { bindAgentStore, defaultStorageBackend } from './backend.ts';
import type { SqliteInstallation } from './storage-lifecycle.ts';
import type { InstallationRows, RecordChange } from './workflow-records.ts';

export function bindInstanceStore(
  installation: SqliteInstallation,
  backend = defaultStorageBackend,
) {
  const root = installation.installationRoot;
  if (backend === 'file') return new AssignmentClaimStore(root);
  const database = async () =>
    (await import('./agent-database.ts')).bindSqliteInstallation(installation);
  return new AssignmentClaimStore(root, {
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
      const { claims, ...value } = state;
      const changes: RecordChange<InstallationRows>[] = [];
      if (saved && saved.instanceId !== value.instanceId)
        changes.push({ table: 'instances', action: 'remove', key: { id: saved.instanceId } });
      changes.push({ table: 'instances', action: 'save', row: { id: value.instanceId, value } });
      for (const [id, claim] of Object.entries(claims))
        if (!isDeepStrictEqual(saved?.claims[id], claim))
          changes.push({ table: 'assignmentClaims', action: 'save', row: { id, value: claim } });
      for (const id of Object.keys(saved?.claims ?? {}))
        if (!Object.hasOwn(claims, id))
          changes.push({ table: 'assignmentClaims', action: 'remove', key: { id } });
      await db.write(changes);
    },
  });
}

export async function bindPickupStore(
  installation: SqliteInstallation,
  agentId: string,
  backend = defaultStorageBackend,
) {
  const agent = await bindAgentStore(agentId, installation, backend);
  return new IssuePickupEnrollmentStore(
    installation.installationRoot,
    bindInstanceStore(installation, backend),
    agent && { agent, agentId },
  );
}
