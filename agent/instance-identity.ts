import type { AgentSystemLifecycleContribution } from '../core/lifecycle-registry.ts';
import type AssignmentClaimStore from './assignment-claim-store.ts';

export default function instanceIdentity(
  store: AssignmentClaimStore,
): AgentSystemLifecycleContribution {
  return {
    id: 'instance-identity',
    isConfigured: () => true,
    async inspect() {
      try {
        const identity = await store.inspect();
        return identity
          ? [
              {
                status: 'healthy',
                code: 'instance-identity-ready',
                message: `name: ${identity.displayName}; id: ${identity.instanceId}`,
              },
            ]
          : [
              {
                status: 'drift',
                code: 'instance-identity-missing',
                message: 'installation identity is missing.',
                remediation: 'run install to initialize it.',
              },
            ];
      } catch (error) {
        if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        return [
          {
            status: 'blocked',
            code: 'instance-identity-invalid',
            message: 'installation identity cannot be read safely.',
            remediation:
              'restore the original private state before continuing; install does not replace invalid identity.',
          },
        ];
      }
    },
    async reconcile() {
      const previous = await store.inspect();
      const identity = await store.identity();
      return {
        outcomes: [
          {
            status: previous ? 'unchanged' : 'created',
            code: 'instance-identity-ready',
            message: `name: ${identity.displayName}; id: ${identity.instanceId}`,
          },
        ],
      };
    },
  };
}

export async function operateInstanceIdentity(
  store: AssignmentClaimStore,
  action: string,
  input: unknown,
) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('instance-request-invalid');
  const request = input as Record<string, unknown>;
  const keys = action === 'rename' ? ['name'] : action === 'rotate' ? ['expectedInstanceId'] : [];
  if (
    !['inspect', 'rename', 'rotate'].includes(action) ||
    Object.keys(request).some((key) => !keys.includes(key))
  )
    throw new Error('instance-request-invalid');
  const identity = await store.inspect();
  if (action === 'inspect')
    return identity ? { status: 'ready' as const, ...identity } : { status: 'missing' as const };
  if (!identity) throw new Error('instance-install-required');
  if (action === 'rename' && typeof request.name === 'string')
    return { status: 'renamed' as const, ...(await store.rename(request.name)) };
  if (action === 'rotate' && typeof request.expectedInstanceId === 'string')
    return { status: 'rotated' as const, ...(await store.rotate(request.expectedInstanceId)) };
  throw new Error('instance-request-invalid');
}
