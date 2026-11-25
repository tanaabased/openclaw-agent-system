import {
  bindSqliteInstallation,
  bindSqliteStorage,
  sqliteAgentDatabases,
} from './agent-database.ts';
import type { SqliteInstallation } from './storage-lifecycle.ts';

export const openClawDatabaseFamilies = { state: 'sqlite', agent: 'sqlite' } as const;

export function bindAgent(
  location: SqliteInstallation,
  agentId: string,
  shared: ReturnType<typeof bindSqliteInstallation>,
) {
  return bindSqliteStorage(location, agentId, shared).agent;
}

export const bindInstallation = bindSqliteInstallation;
export const agentStores = sqliteAgentDatabases;

export const protectedAgentPath = (location: SqliteInstallation) => location.agentRoot;
export const protectedInstallationPath = (location: SqliteInstallation) =>
  location.installationRoot;

export const openClawSnapshot = {
  databaseFilename: 'openclaw-agent.sqlite',
  create: (agentId: string, repository: string) => [
    'backup',
    'sqlite',
    'create',
    '--agent',
    agentId,
    '--repository',
    repository,
    '--json',
  ],
  verify: (directory: string) => ['backup', 'sqlite', 'verify', directory, '--json'],
  restore: (directory: string, target: string) => [
    'backup',
    'sqlite',
    'restore',
    directory,
    '--target',
    target,
    '--json',
  ],
};
