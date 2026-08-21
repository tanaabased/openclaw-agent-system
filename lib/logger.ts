import { formatErrorMessage } from 'openclaw/plugin-sdk/error-runtime';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';
import { getChildLogger } from 'openclaw/plugin-sdk/runtime';

import type { AgentManifestLoadResult } from './agent-manifest-service.ts';

export type Logger = PluginLogger;

export interface AgentSystemDiagnostic {
  code?: string;
  component: string;
  fieldPath?: string;
  message: string;
}

export interface AgentSystemFormattedDiagnostic {
  level: 'error' | 'warning';
  message: string;
}

export interface CreateAgentSystemLoggerOptions {
  hostAttributed?: boolean;
}

export interface CreateAgentSystemLifecycleLoggerOptions extends CreateAgentSystemLoggerOptions {
  writeFileDebug?: (message: string) => void;
  writeFileInfo?: (message: string) => void;
}

function loggerNamespace(pluginId: string): string {
  return pluginId.replace(/^openclaw-/, '');
}

function prefixMessage(namespace: string, message: string): string {
  const prefix = `[${namespace}]`;
  return message === prefix || message.startsWith(`${prefix} `) ? message : `${prefix} ${message}`;
}

/** Preserve host logger routing while adding the plugin namespace exactly once when needed. */
export function createAgentSystemLogger(
  logger: PluginLogger,
  pluginId: string,
  options: CreateAgentSystemLoggerOptions = {},
): Logger {
  const namespace = loggerNamespace(pluginId);
  const format = options.hostAttributed
    ? (message: string) => message
    : (message: string) => prefixMessage(namespace, message);

  return {
    ...(logger.debug ? { debug: (message: string) => logger.debug?.(format(message)) } : {}),
    error: (message) => logger.error(format(message)),
    info: (message) => logger.info(format(message)),
    warn: (message) => logger.warn(format(message)),
  };
}

/** Keep routine lifecycle metadata in file logs so it cannot become command output. */
export function createAgentSystemLifecycleLogger(
  logger: PluginLogger,
  pluginId: string,
  options: CreateAgentSystemLifecycleLoggerOptions = {},
): Logger {
  let fileLogger: ReturnType<typeof getChildLogger> | undefined;
  const writeFileDebug =
    options.writeFileDebug ??
    ((message: string) => {
      fileLogger ??= getChildLogger({ subsystem: 'plugins' });
      fileLogger.debug(message);
    });
  const writeFileInfo =
    options.writeFileInfo ??
    ((message: string) => {
      fileLogger ??= getChildLogger({ subsystem: 'plugins' });
      fileLogger.info(message);
    });

  return createAgentSystemLogger(
    {
      debug: writeFileDebug,
      error: logger.error.bind(logger),
      info: writeFileInfo,
      warn: logger.warn.bind(logger),
    },
    pluginId,
    options,
  );
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

export function formatErrorDiagnostic(component: string, error: unknown, code?: string): string {
  return formatDiagnostic({
    ...(code ? { code } : {}),
    component,
    message: formatErrorMessage(error),
  });
}

export function formatManifestDiagnostics(
  result: AgentManifestLoadResult,
): AgentSystemFormattedDiagnostic[] {
  return result.diagnostics.map((diagnostic) => ({
    level: diagnostic.severity === 'warning' ? 'warning' : 'error',
    message: formatDiagnostic({
      code: diagnostic.code,
      component: diagnostic.component ?? 'manifest',
      ...(diagnostic.fieldPath ? { fieldPath: diagnostic.fieldPath } : {}),
      message: diagnostic.message,
    }),
  }));
}

export function formatManifestFailure(
  result: Exclude<AgentManifestLoadResult, { status: 'loaded' }>,
): AgentSystemFormattedDiagnostic[] {
  const summary =
    result.status === 'unmanaged'
      ? `manifest: no Agent System manifest found in ${result.scope.workspaceDir}`
      : result.status === 'invalid'
        ? `manifest: invalid Agent System manifest${result.path ? ` at ${result.path}` : ''}`
        : 'manifest: an OpenClaw agent workspace could not be resolved';
  return [{ level: 'error', message: summary }, ...formatManifestDiagnostics(result)];
}

export function reportError(
  logger: Logger,
  component: string,
  error: unknown,
  code?: string,
): void {
  logger.error(formatErrorDiagnostic(component, error, code));
}

export function reportManifestDiagnostics(result: AgentManifestLoadResult, logger: Logger): void {
  for (const diagnostic of formatManifestDiagnostics(result)) {
    if (diagnostic.level === 'warning') logger.warn(diagnostic.message);
    else logger.error(diagnostic.message);
  }
}

export function reportManifestFailure(
  result: Exclude<AgentManifestLoadResult, { status: 'loaded' }>,
  logger: Logger,
): void {
  for (const diagnostic of formatManifestFailure(result)) {
    if (diagnostic.level === 'warning') logger.warn(diagnostic.message);
    else logger.error(diagnostic.message);
  }
}
