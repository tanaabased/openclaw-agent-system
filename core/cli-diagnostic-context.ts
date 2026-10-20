/** producer-owned correlation; omitted scope is never a wildcard. */
export interface CliCondition {
  key: string;
  component: string;
  fieldPath?: string;
  stepId?: string;
  resource?: string;
  occurrence?: string;
}

export interface CliDiagnosticContext {
  condition: CliCondition;
  remediation?: readonly string[];
}

// enumerable symbols survive lifecycle spreads but never enter serialized results.
export const cliDiagnosticContext = Symbol('cli-diagnostic-context');

export function getCliDiagnosticContext(value: object): CliDiagnosticContext | undefined {
  return (value as { [cliDiagnosticContext]?: CliDiagnosticContext })[cliDiagnosticContext];
}
