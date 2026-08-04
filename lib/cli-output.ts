import type { AgentManifestLoadResult } from './agent-manifest-service.ts';

export interface CliOutput {
  error(message: string): void;
  write(message: string): void;
}

export const defaultCliOutput: CliOutput = {
  error(message) {
    process.stderr.write(message);
  },
  write(message) {
    process.stdout.write(message);
  },
};

export function reportManifestDiagnostics(
  result: AgentManifestLoadResult,
  output: CliOutput,
): void {
  for (const diagnostic of result.diagnostics) {
    const location = diagnostic.fieldPath ? ` (${diagnostic.fieldPath})` : '';
    output.error(`${diagnostic.severity}: [${diagnostic.code}]${location} ${diagnostic.message}\n`);
  }
}

export function reportManifestFailure(
  result: Exclude<AgentManifestLoadResult, { status: 'loaded' }>,
  output: CliOutput,
): void {
  if (result.status === 'unmanaged') {
    output.error(`error: no Agent System manifest found in ${result.scope.workspaceDir}\n`);
  } else if (result.status === 'invalid') {
    output.error(
      `error: invalid Agent System manifest${result.path ? ` at ${result.path}` : ''}\n`,
    );
    reportManifestDiagnostics(result, output);
  } else {
    output.error('error: an OpenClaw agent workspace could not be resolved\n');
    reportManifestDiagnostics(result, output);
  }
}
