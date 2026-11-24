import type { AutomationGatewayDiagnostic } from './automation-gateway-diagnostic.ts';

export class AutomationError extends Error {
  automationId?: string;

  constructor(
    readonly code: string,
    readonly diagnostic?: AutomationGatewayDiagnostic,
  ) {
    super(
      `Automation operation failed (${code}).` +
        (diagnostic?.reason ? ` ${diagnostic.method}: ${diagnostic.reason}.` : ''),
    );
  }
}

export class AutomationVerificationError extends AutomationError {
  constructor(
    readonly check:
      | 'manifest-agent-mismatch'
      | 'scope-agent-mismatch'
      | 'registration-missing'
      | 'registration-ambiguous'
      | 'automation-id-mismatch'
      | 'registration-pending'
      | 'registration-retired'
      | 'registration-removed'
      | 'declaration-missing'
      | 'declaration-not-prompt'
      | 'runtime-mismatch'
      | 'declaration-disabled'
      | 'declaration-hash-mismatch'
      | 'native-hash-missing',
  ) {
    super('automation-lifecycle-unverified');
  }
}

export class CodexAutomationError extends Error {
  automationId?: string;
  override name = 'CodexAutomationError';
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}
