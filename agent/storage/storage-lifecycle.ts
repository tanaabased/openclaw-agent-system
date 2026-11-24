import type {
  AgentSystemLifecycleContext,
  AgentSystemLifecycleFinding,
  AgentSystemLifecycleOutcome,
} from '../../core/lifecycle-registry.ts';
import type { IntakeState } from '../../channels/github/intake/record-store.ts';
import type { RepositoryRecord } from '../../tools/git/repository-service.ts';

export interface StorageBinding {
  runtime: 'openclaw' | 'codex';
  agentId: string;
  workspaceDir: string;
}

export interface StorageSchema {
  inspect(): Promise<AgentSystemLifecycleFinding>;
  install(): Promise<AgentSystemLifecycleOutcome>;
}

/** The runtime binds both handles before a workflow can read or change any records. */
export interface BoundStorage {
  agent: {
    readIntake(scope: string): Promise<IntakeState | undefined>;
    saveIntake(state: IntakeState): Promise<void>;
    clearIntake(scope: string): Promise<void>;
  };
  installation: {
    readRepository(root: string, id: string): Promise<RepositoryRecord | undefined>;
    saveRepository(root: string, record: RepositoryRecord): Promise<void>;
  };
}

/** Register one migration target per physical database or shared schema. */
export function storageSchemaLifecycle(
  id: string,
  resolve: (context: AgentSystemLifecycleContext) => Promise<StorageSchema>,
) {
  return {
    id,
    isConfigured: () => true,
    async inspect(context: AgentSystemLifecycleContext) {
      const schema = await resolve(context);
      return [await schema.inspect()];
    },
    async reconcile(context: AgentSystemLifecycleContext) {
      const schema = await resolve(context);
      return { outcomes: [await schema.install()] };
    },
  };
}

export function sqliteStorageLifecycle(
  runtime: StorageBinding['runtime'],
  installation: () => { agentRoot: string; installationRoot: string; schemaRoot: string },
) {
  return (['agent', 'installation'] as const).map((scope) =>
    storageSchemaLifecycle(scope + '-storage', async ({ manifest, workspaceDir }) => {
      const { bindSqliteStorage } = await import('./agent-database.ts');
      return bindSqliteStorage(installation(), {
        runtime,
        agentId: manifest.agent.id,
        workspaceDir,
      })[scope];
    }),
  );
}
