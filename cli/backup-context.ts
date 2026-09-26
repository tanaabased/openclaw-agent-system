import { resolve } from 'node:path';

import {
  type AgentCommandBinding,
  type default as AgentCommandAuthority,
  agentCommandAuthorityEnvironmentName,
  agentCommandCapabilityEnvironmentName,
} from '../agent/command-authority.ts';
import { BackupError, backupDefaultOutput } from '../agent/backup-types.ts';
import { canonicalBackupPath } from '../agent/backup-selection.ts';
import type AgentManifestService from '../manifest/service.ts';
import isPathContained from '../utils/is-path-contained.ts';
import { formatManifestFailure } from '../core/logger.ts';

export interface BackupCommandContext {
  agentId?: string;
  commandAuthority?: Pick<AgentCommandAuthority, 'resolve'>;
  environment: Readonly<NodeJS.ProcessEnv>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  workspaceDir: string;
}

/** identify a caller before loading agent metadata; invalid authority never becomes operator access. */
export async function resolveBackupCaller(
  options: BackupCommandContext,
): Promise<AgentCommandBinding | undefined> {
  const binding = await options.commandAuthority?.resolve(
    options.environment,
    options.workspaceDir,
  );
  if (
    !binding &&
    (options.environment[agentCommandAuthorityEnvironmentName] !== undefined ||
      options.environment[agentCommandCapabilityEnvironmentName] !== undefined ||
      (options.environment.CODEX_THREAD_ID && options.environment.OPENCLAW_STATE_DIR))
  )
    throw new BackupError(
      'backup-authority-unresolved',
      'The active agent command authority could not be verified.',
    );
  if (binding && options.agentId !== undefined)
    throw new BackupError(
      'backup-agent-selector-forbidden',
      'Bound backup callers cannot supply --agent. Use the active agent binding.',
    );
  return binding;
}

export async function loadBackupManifest(
  options: BackupCommandContext,
  binding?: AgentCommandBinding,
) {
  const agentId = binding?.agentId ?? options.agentId;
  const loaded = agentId
    ? await options.manifestService.loadForAgentId(agentId, 'cli')
    : await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  if (loaded.status !== 'loaded')
    throw new BackupError(
      'backup-manifest-unavailable',
      formatManifestFailure(loaded)
        .map(({ message }) => message)
        .join(' '),
    );
  if (agentId && loaded.manifest.agent.id !== agentId)
    throw new BackupError(
      'backup-agent-mismatch',
      'The selected manifest does not match the trusted agent identity.',
    );
  return loaded;
}

export async function assertBackupArchiveLocation(
  archive: string,
  workspaceDir: string,
  configuredOutput?: string,
): Promise<string> {
  const path = await canonicalBackupPath(archive);
  const workspace = await canonicalBackupPath(workspaceDir);
  const output = await canonicalBackupPath(
    resolve(workspace, configuredOutput ?? backupDefaultOutput),
  );
  if (!isPathContained(workspace, path) && !isPathContained(output, path))
    throw new BackupError(
      'backup-archive-outside-scope',
      'Bound callers may verify only archives inside their workspace or configured backup destination.',
    );
  return path;
}

/** retain the authority boundary when a configured external destination contains another manifest. */
export async function assertBackupLocationOwner(
  options: BackupCommandContext,
  binding: AgentCommandBinding,
  path: string,
): Promise<void> {
  const selected = await options.manifestService.loadForCommandDirectory(path, 'cli');
  if (
    selected.status !== 'unmanaged' &&
    (selected.status !== 'loaded' || selected.manifest.agent.id !== binding.agentId)
  )
    throw new BackupError(
      'backup-location-agent-mismatch',
      'The backup location belongs to another or invalid agent workspace.',
    );
}
