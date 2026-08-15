import { formatErrorMessage } from 'openclaw/plugin-sdk/error-runtime';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';

import type { AgentManifestLoadResult } from './agent-manifest-service.ts';

export type Logger = PluginLogger;

export interface AgentSystemDiagnostic {
  code?: string;
  component: string;
  fieldPath?: string;
  message: string;
}

export function formatDiagnostic(diagnostic: AgentSystemDiagnostic): string {
  return [
    `${diagnostic.component}: ${diagnostic.message}`,
    diagnostic.code ? `code=${diagnostic.code}` : undefined,
    diagnostic.fieldPath ? `field=${diagnostic.fieldPath}` : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');
}

export function reportError(
  logger: Logger,
  component: string,
  error: unknown,
  code?: string,
): void {
  logger.error(
    formatDiagnostic({
      ...(code ? { code } : {}),
      component,
      message: formatErrorMessage(error),
    }),
  );
}

export function reportManifestDiagnostics(result: AgentManifestLoadResult, logger: Logger): void {
  for (const diagnostic of result.diagnostics) {
    const message = formatDiagnostic({
      code: diagnostic.code,
      component: diagnostic.component ?? 'manifest',
      ...(diagnostic.fieldPath ? { fieldPath: diagnostic.fieldPath } : {}),
      message: diagnostic.message,
    });
    if (diagnostic.severity === 'warning') logger.warn(message);
    else logger.error(message);
  }
}

export function reportManifestFailure(
  result: Exclude<AgentManifestLoadResult, { status: 'loaded' }>,
  logger: Logger,
): void {
  if (result.status === 'unmanaged') {
    logger.error(`manifest: no Agent System manifest found in ${result.scope.workspaceDir}`);
  } else if (result.status === 'invalid') {
    logger.error(
      `manifest: invalid Agent System manifest${result.path ? ` at ${result.path}` : ''}`,
    );
    reportManifestDiagnostics(result, logger);
  } else {
    logger.error('manifest: an OpenClaw agent workspace could not be resolved');
    reportManifestDiagnostics(result, logger);
  }
}
