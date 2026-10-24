import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import type {
  AgentSystemLifecycleContribution,
  AgentSystemLifecycleExecutionContext,
} from '../core/lifecycle-registry.ts';
import sessionDispatchRequirements from './session-dispatch-requirements.ts';

export default function createSessionDispatchLifecycle(
  service: SessionDispatchCredential,
): AgentSystemLifecycleContribution {
  return {
    id: 'session-dispatch',
    isConfigured: () => true,
    async inspect(context: AgentSystemLifecycleExecutionContext) {
      if (
        context.runtime !== 'openclaw' ||
        !sessionDispatchRequirements(context.manifest, context.manualSessionDispatch).length
      )
        return [
          {
            code: 'session-dispatch-not-required',
            status: 'skipped',
            message:
              'No enabled OpenClaw automation requires session dispatch; existing enrollment is retained.',
          },
        ];
      return [await service.inspect()];
    },
    async reconcile(context: AgentSystemLifecycleExecutionContext) {
      if (
        context.runtime !== 'openclaw' ||
        !sessionDispatchRequirements(context.manifest, context.manualSessionDispatch).length
      )
        return {
          outcomes: [
            {
              code: 'session-dispatch-not-required',
              status: 'skipped',
              message: 'Session dispatch enrollment is not required.',
            },
          ],
        };
      return { outcomes: [await service.enroll(context)] };
    },
  };
}
