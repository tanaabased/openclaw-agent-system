import { AutomationError } from '../agent/automation-gateway.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import { redactedErrorMessage } from '../core/logger.ts';
import type { CliNotice } from './output.ts';

/** keep safe failure evidence and recovery in one condition, outside result data. */
export default function automationFailureNotice(
  error: unknown,
  code: string,
  options: { sync?: boolean; resource?: string } = {},
): CliNotice {
  const lifecycle = error instanceof AgentSystemLifecycleError ? error : undefined;
  const failure = lifecycle ? lifecycle.cause : error;
  const diagnostic = failure instanceof AutomationError ? failure.diagnostic : undefined;
  const progress = lifecycle?.progress;
  return {
    severity: 'error',
    stepId: lifecycle?.stepId,
    resource: options.resource,
    code,
    component: lifecycle?.component ?? 'automations',
    message:
      failure instanceof AutomationError || failure === undefined
        ? 'automation operation stopped.'
        : redactedErrorMessage(failure),
    details: [
      ...(progress
        ? [
            `partial progress: completed=${progress.outcomes.length} warnings=${progress.warnings.length} unattempted=${progress.unattempted.length}; ${progress.outcomes.length > 0 ? 'completed changes remain applied' : 'no completed changes reported'}; the stopped operation may have partial effects.`,
          ]
        : []),
      ...(diagnostic ? [`gateway diagnostic: ${JSON.stringify(diagnostic)}`] : []),
    ],
    remediation: [
      options.sync
        ? code === 'automation-gateway-unavailable'
          ? 'restore gateway connectivity before rerunning openclaw agent-system automations sync.'
          : 'resolve the reported cause before rerunning openclaw agent-system automations sync.'
        : 'check automation configuration and runtime availability before retrying the operation.',
    ],
  };
}
