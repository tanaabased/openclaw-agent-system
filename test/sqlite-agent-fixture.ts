import { bindSqliteStorage } from '../agent/storage/agent-database.ts';
import codexStorageLocation from '../agent/storage/codex-storage.ts';

export default async function sqliteAgentFixture(root: string, agentId: string) {
  const sqliteInstallation = codexStorageLocation(root);
  const { agent } = bindSqliteStorage(sqliteInstallation, agentId);
  await agent.install();
  return { agent, sqliteInstallation, storageBackend: 'sqlite' as const };
}
