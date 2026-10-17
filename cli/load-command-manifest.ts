import type AgentManifestService from '../manifest/service.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { formatManifestDiagnostics, formatManifestFailure } from '../core/logger.ts';
import { type CliDiagnosticOptions, writeCliDiagnosticNotices } from './output.ts';

interface LoadCommandManifestOptions extends CliDiagnosticOptions {
  agentId?: string;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  setExitCode(code: number): void;
  workspaceDir: string;
}

/** Load the selected manifest and keep all diagnostics off primary command output. */
export default async function loadCommandManifest(
  options: LoadCommandManifestOptions,
): Promise<Extract<AgentManifestLoadResult, { status: 'loaded' }> | undefined> {
  const result = options.agentId
    ? await options.manifestService.loadForAgentId(options.agentId, 'cli')
    : await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  const diagnostics =
    result.status === 'loaded' ? formatManifestDiagnostics(result) : formatManifestFailure(result);
  writeCliDiagnosticNotices(
    options,
    diagnostics.map(({ level, message }) => ({ severity: level, message })),
  );
  if (result.status !== 'loaded') {
    options.setExitCode(1);
    return;
  }
  return result;
}
