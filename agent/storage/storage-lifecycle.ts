import type { AgentRows, InstallationRows, WorkflowRecords } from './workflow-records.ts';
import type {
  AgentSystemLifecycleContext,
  AgentSystemLifecycleFinding,
  AgentSystemLifecycleOutcome,
} from '../../core/lifecycle-registry.ts';
import type { IntakeState } from '../../channels/github/intake/record-store.ts';
import type { RepositoryRecord } from '../../tools/git/repository-service.ts';

export interface SqliteInstallation {
  agentRoot: string;
  installationRoot: string;
  schemaRoot: string;
}

export interface StorageSchema {
  inspect(): Promise<AgentSystemLifecycleFinding>;
  install(): Promise<AgentSystemLifecycleOutcome>;
}

type DirectRow = AgentRows['directEntries'];
type Draft = AgentRows['replyDrafts']['value'];
export interface SessionStorage {
  readReplies(scope: string): Promise<Draft[]>;
  saveReplies(scope: string, changed: Draft[], removed: string[]): Promise<void>;
  readDirectEntries(scope: string, kind: DirectRow['kind']): Promise<DirectRow['value'][]>;
  saveDirectEntries(
    scope: string,
    kind: DirectRow['kind'],
    entries: DirectRow['value'][],
  ): Promise<void>;
}

/** The runtime binds both handles before a workflow can read or change any records. */
export interface BoundStorage {
  agent: WorkflowRecords<AgentRows> &
    SessionStorage & {
      changeReport(
        id: string,
        change: (
          row?: AgentRows['automationReports'],
        ) => AgentRows['automationReports'] | undefined,
      ): Promise<void>;
      retainIdentityPin(
        row: AgentRows['githubIdentityPins'],
        validate: (entries: Record<string, AgentRows['githubIdentityPins']['value']>) => void,
      ): Promise<void>;
      replacePathProjection(value: AgentRows['pathProjections']['value']): Promise<void>;
      listReportIds(
        selection: 'all' | 'recoverable' | { completedBefore: string },
      ): Promise<string[]>;
      listIntakeScopes(): Promise<string[]>;
      readIntake(scope: string): Promise<IntakeState | undefined>;
      saveDispatch(
        scope: string,
        state: AgentRows['dispatchState']['value'] & {
          records: AgentRows['dispatchRecords']['value'][];
        },
      ): Promise<void>;
      saveIntake(state: IntakeState): Promise<void>;
      clearIntake(scope: string): Promise<void>;
    };
  installation: WorkflowRecords<InstallationRows> & {
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

export function sqliteStorageLifecycle(installation: () => SqliteInstallation) {
  return (['agent', 'installation'] as const).map((scope) =>
    storageSchemaLifecycle(
      scope === 'agent' ? 'agent-storage' : 'agent-system-storage',
      async ({ manifest }) => {
        const { bindSqliteStorage } = await import('./agent-database.ts');
        return bindSqliteStorage(installation(), manifest.agent.id)[scope];
      },
    ),
  );
}
