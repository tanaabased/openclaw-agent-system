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

/** Identify stable Agent System tool failures without exposing runtime details. */
export default class AgentSystemToolError extends Error {
  override name = 'AgentSystemToolError';

  constructor(
    readonly code: AgentSystemToolErrorCode,
    message: string,
    readonly credentialRejected = false,
    readonly providerDiagnostic?: ProviderDiagnostic,
  ) {
    super(withProviderDiagnostic(message, providerDiagnostic));
  }
}
