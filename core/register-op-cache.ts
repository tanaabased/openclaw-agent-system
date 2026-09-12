import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type OpEnvironmentService from '../environment/op-service.ts';

/** Expose metadata and invalidation through the public, operator-authorized Gateway boundary. */
export default function registerOpCache(
  api: Pick<OpenClawPluginApi, 'registerGatewayMethod' | 'registerService'>,
  service: Pick<OpEnvironmentService, 'status' | 'flush'>,
): void {
  for (const action of ['status', 'flush'] as const) {
    const scope = action === 'flush' ? 'operator.admin' : 'operator.read';
    api.registerGatewayMethod(
      `agent-system.op-cache.${action}`,
      ({ client, params, respond }) => {
        if (
          client?.invalidated ||
          client?.connect.role !== 'operator' ||
          !client.connect.scopes?.some((value) => value === scope || value === 'operator.admin')
        ) {
          respond(false, undefined, {
            code: 'INVALID_REQUEST',
            message: 'Operator cache access is required.',
          });
          return;
        }
        if (
          Object.keys(params).some((key) => key !== 'agentId') ||
          (params.agentId !== undefined &&
            (typeof params.agentId !== 'string' ||
              !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(params.agentId)))
        ) {
          respond(false, undefined, {
            code: 'INVALID_REQUEST',
            message: 'Invalid OP cache parameters.',
          });
          return;
        }
        try {
          // Resolve current policy even for flush, before changing the selected generation.
          service.status();
          const invalidated =
            action === 'flush' ? service.flush(params.agentId as string | undefined) : undefined;
          respond(true, {
            ...service.status(),
            runtime: 'gateway',
            ...(invalidated ? { invalidated } : {}),
          });
        } catch {
          respond(false, undefined, {
            code: 'UNAVAILABLE',
            message: 'The operator OP cache policy is invalid.',
          });
        }
      },
      { scope },
    );
  }
  api.registerService({
    id: 'agent-system-op-cache',
    reload: { configPrefixes: ['agents', 'plugins.entries.agent-system.config'] },
    start() {
      service.status();
    },
    stop() {
      service.flush();
    },
  });
}
