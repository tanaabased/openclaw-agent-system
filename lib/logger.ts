import { formatErrorMessage } from 'openclaw/plugin-sdk/error-runtime';
import type { PluginLogger } from 'openclaw/plugin-sdk/plugin-entry';
import { getChildLogger, getConsoleSettings } from 'openclaw/plugin-sdk/runtime';

import type { AgentManifestLoadResult } from './agent-manifest-service.ts';

export type Logger = PluginLogger;

export interface AgentSystemDiagnostic {
  code?: string;
  component: string;
  fieldPath?: string;
  message: string;
}

export interface CreateAgentSystemLoggerOptions {
  hostAttributed?: boolean;
}

export interface CreateAgentSystemLifecycleLoggerOptions extends CreateAgentSystemLoggerOptions {
  consoleDebugEnabled?: () => boolean;
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

/** Keep routine lifecycle metadata in file logs unless console debugging is explicit. */
export function createAgentSystemLifecycleLogger(
  logger: PluginLogger,
  pluginId: string,
  options: CreateAgentSystemLifecycleLoggerOptions = {},
): Logger {
  const consoleDebugEnabled =
    options.consoleDebugEnabled ??
    (() => {
      const level = getConsoleSettings().level;
      return level === 'debug' || level === 'trace';
    });
  let fileLogger: ReturnType<typeof getChildLogger> | undefined;
  const writeFileInfo =
    options.writeFileInfo ??
    ((message: string) => {
      fileLogger ??= getChildLogger({ subsystem: 'plugins' });
      fileLogger.info(message);
    });

  return createAgentSystemLogger(
    {
      ...(logger.debug ? { debug: logger.debug.bind(logger) } : {}),
      error: logger.error.bind(logger),
      info(message) {
        if (consoleDebugEnabled()) logger.info(message);
        else writeFileInfo(message);
      },
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
