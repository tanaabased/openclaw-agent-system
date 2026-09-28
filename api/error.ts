import { withProviderDiagnostic, type ProviderDiagnostic } from '../utils/provider-diagnostic.ts';
export type AgentSystemToolErrorCode =
  | 'agent_not_resolved'
  | 'approval_denied'
  | 'capability_not_configured'
  | 'configuration_unavailable'
  | 'credential_unavailable'
  | 'execution_failed'
  | 'execution_timed_out'
  | 'invalid_arguments'
  | 'operation_unclassified'
  | 'resource_cleanup_failed'
  | 'tool_identity_mismatch'
  | 'tool_unavailable';

export interface AgentSystemToolFailureDiagnostic {
  stage: 'authorization' | 'publication' | 'checkpoint';
  category:
    | 'authority-revoked'
    | 'github-request'
    | 'invalid-response'
    | 'identity-mismatch'
    | 'state-or-configuration'
    | 'checkpoint-failed';
}

/** Identify stable Agent System tool failures without exposing runtime details. */
export default class AgentSystemToolError extends Error {
  override name = 'AgentSystemToolError';

  constructor(
    readonly code: AgentSystemToolErrorCode,
    message: string,
    readonly credentialRejected = false,
    readonly providerDiagnostic?: ProviderDiagnostic,
    readonly failureDiagnostic?: AgentSystemToolFailureDiagnostic,
  ) {
    super(withProviderDiagnostic(message, providerDiagnostic));
  }
}
