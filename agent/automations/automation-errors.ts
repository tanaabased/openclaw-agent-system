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
