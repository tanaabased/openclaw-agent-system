import presentCliCommand from './presentation.ts';
import type AgentEnvironmentService from '../environment/service.ts';
import {
  type CliOutput,
  type CliStyles,
  renderCliTableRows,
  writeCliDiagnosticNotices,
  writeCliJson,
  writeCliSummary,
} from './output.ts';
import { formatManifestDiagnostics, formatManifestFailure } from '../core/logger.ts';
import type { AgentEnvironmentVariable } from '../environment/resolve.ts';

export interface EnvAgentSystemOptions {
  agentId?: string;
  environmentService: Pick<AgentEnvironmentService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  json: boolean;
  output: CliOutput;
  setExitCode(code: number): void;
  styles?: CliStyles;
  workspaceDir: string;
  terminalColumns?: number;
}

interface EnvironmentView {
  agentId: string;
  manifestPath: string;
  variables: AgentEnvironmentVariable[];
  workspaceDir: string;
}

function writeHuman(
  output: CliOutput,
  view: EnvironmentView,
  styles?: CliStyles,
  terminalColumns = process.stdout.columns,
): void {
  writeCliSummary(
    output,
    [
      { label: 'agent', style: 'field', value: view.agentId },
      { label: 'manifest', style: 'field', value: view.manifestPath },
      { label: 'workspace', style: 'field', value: view.workspaceDir },
    ],
    styles,
    { terminalColumns },
  );
  const headers = ['variable', 'source', 'required', 'overrides'];
  const rows = [
    { cells: headers.map((value) => ({ value, style: 'bold' as const })) },
    ...view.variables.map((variable) => ({
      cells: [
        { value: variable.name, style: 'field' as const },
        { value: variable.source },
        { value: String(variable.required) },
        { value: String(variable.overriddenSources.length) },
      ],
    })),
  ];
  const table = renderCliTableRows(rows, styles, { terminalColumns });
  output.writeStdout(`\n${table.join('\n')}\n`);
  if (view.variables.length === 0) output.writeStdout('no environment variables\n');
}

/** Inspect Agent System environment metadata without exposing values. */
async function envAgentSystem(options: EnvAgentSystemOptions): Promise<void> {
  const result = options.agentId
    ? await options.environmentService.loadForAgentId(options.agentId, 'cli')
    : await options.environmentService.loadForCommandDirectory(options.workspaceDir, 'cli');

  if (result.status !== 'loaded') {
    writeCliDiagnosticNotices(
      options,
      formatManifestFailure(result).map(({ level, message }) => ({ severity: level, message })),
    );
    options.setExitCode(1);
    return;
  }

  writeCliDiagnosticNotices(
    options,
    formatManifestDiagnostics(result).map(({ level, message }) => ({ severity: level, message })),
  );
  const view: EnvironmentView = {
    agentId: result.manifest.agent.id,
    manifestPath: result.path,
    variables: result.environment.variables,
    workspaceDir: result.scope.workspaceDir,
  };
  if (options.json) writeCliJson(options.output, view);
  else writeHuman(options.output, view, options.styles, options.terminalColumns);
}

export default presentCliCommand(envAgentSystem);
