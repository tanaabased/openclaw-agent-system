import { writeCliError, writeCliLines, type CliOutput } from './output.ts';

export type OpCacheGatewayRequest = (
  action: 'status' | 'flush',
  agentId?: string,
) => Promise<Record<string, unknown>>;

export const requestOpCacheGateway: OpCacheGatewayRequest = async (action, agentId) => {
  const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
  const result = await callGatewayFromCli(
    `agent-system.op-cache.${action}`,
    { timeout: '5000' },
    agentId === undefined ? {} : { agentId },
    { progress: false, scopes: [action === 'flush' ? 'operator.admin' : 'operator.read'] },
  );
  if (result.runtime !== 'gateway' || (action === 'flush' && !result.invalidated)) {
    throw new Error('No Gateway cache acknowledgment.');
  }
  return result;
};

/** Never substitute a short-lived CLI cache for the running Gateway. */
export default async function credentialsCache(options: {
  action: 'status' | 'flush';
  agentId?: string;
  output: CliOutput;
  request?: OpCacheGatewayRequest;
  setExitCode(code: number): void;
}): Promise<void> {
  try {
    const result = await (options.request ?? requestOpCacheGateway)(
      options.action,
      options.agentId,
    );
    writeCliLines(options.output, [JSON.stringify(result, null, 2)]);
  } catch {
    writeCliError(
      options.output,
      'credentials: Gateway cache request was not confirmed. Gateway may be unreachable, unauthorized, or incompatible; no local clear is Gateway success.',
    );
    options.setExitCode(1);
  }
}
