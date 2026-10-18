import { getCliDiagnosticContext } from '../core/cli-diagnostic-context.ts';
import { formatManifestFailure } from '../core/logger.ts';
import type { AgentSystemLifecycleWarning } from '../core/lifecycle-registry.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { withProviderDiagnostic } from '../utils/provider-diagnostic.ts';
import type { CliNotice } from './output.ts';

export function manifestNotices(result: AgentManifestLoadResult): CliNotice[] {
  return [
    ...(result.status === 'loaded'
      ? []
      : formatManifestFailure(result)
          .slice(0, 1)
          .map(({ message }) => ({
            severity: 'error' as const,
            message,
          }))),
    ...result.diagnostics.map((diagnostic): CliNotice => ({
      ...getCliDiagnosticContext(diagnostic),
      code: diagnostic.code,
      component: diagnostic.component ?? 'manifest',
      fieldPath: diagnostic.fieldPath,
      severity: diagnostic.severity === 'warning' ? 'warning' : 'error',
      message: withProviderDiagnostic(diagnostic.message, diagnostic.providerDiagnostic),
    })),
  ];
}

export function lifecycleWarningNotice(warning: AgentSystemLifecycleWarning): CliNotice {
  const context = getCliDiagnosticContext(warning);
  return {
    ...context,
    code: warning.code,
    component: warning.component,
    stepId: warning.stepId,
    fieldPath: context?.condition.fieldPath,
    message: warning.message,
    severity: 'warning',
  };
}
