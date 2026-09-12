import type OpCache from '../environment/op-cache.ts';
import {
  writeCliError,
  writeCliJson,
  writeCliSummary,
  type CliOutput,
  type CliStyles,
  type CliSummaryLine,
} from './output.ts';

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
  json?: boolean;
  output: CliOutput;
  styles?: CliStyles;
  request?: OpCacheGatewayRequest;
  setExitCode(code: number): void;
}): Promise<void> {
  try {
    const result = await (options.request ?? requestOpCacheGateway)(
      options.action,
      options.agentId,
    );
    if (options.json) {
      writeCliJson(options.output, result);
      return;
    }
    const { policy, process, entries, backoff, counts, invalidated } = result as ReturnType<
      OpCache['status']
    > & { invalidated?: ReturnType<OpCache['flush']> };
    const lines: CliSummaryLine[] = [
      { label: 'gateway', style: 'target', value: `pid ${process.pid} (${process.scope})` },
      {
        label: 'policy',
        style: 'field',
        value: `${policy.mode}${policy.mode === 'timed' ? ` (${policy.durationSeconds}s)` : ''}; max entries ${policy.maxEntries}`,
      },
    ];
    if (invalidated) {
      lines.push({
        label: 'flushed',
        style: 'status',
        value: `${options.agentId ?? 'all agents'}: ${invalidated.entries} entries, ${invalidated.clients} clients, ${invalidated.pending} pending loads, ${invalidated.values} snapshots`,
      });
    } else {
      lines.push({
        label: 'entries',
        style: 'field',
        value: `${entries.length} retained; ${entries.filter((entry) => entry.cached).length} cached`,
      });
      for (const entry of entries) {
        const age =
          entry.ageMs === null ? 'not retrieved' : `age ${Math.floor(entry.ageMs / 1000)}s`;
        const expiry = !entry.cached
          ? 'no snapshot'
          : entry.expired
            ? 'expired'
            : entry.expiresInMs === null
              ? 'no expiry'
              : `expires in ${Math.ceil(entry.expiresInMs / 1000)}s`;
        lines.push({
          label: 'agent',
          style: 'field',
          value: `${entry.agentId}: ${age}; ${expiry}${entry.pending ? '; pending' : ''}`,
        });
      }
      lines.push({
        label: 'counts',
        style: 'field',
        value: `${counts.clientCreations} clients, ${counts.resourceReads} reads, ${counts.hits} hits, ${counts.misses} misses, ${counts.coalesced} coalesced, ${counts.failures} failures, ${counts.backoffSkips} backoff skips`,
      });
    }
    lines.push({
      label: 'backoff',
      style: backoff.retryInMs > 0 ? 'warning' : 'field',
      value:
        backoff.retryInMs > 0 ? `active; retry in ${Math.ceil(backoff.retryInMs / 1000)}s` : 'none',
    });
    writeCliSummary(options.output, lines, options.styles);
  } catch {
    writeCliError(
      options.output,
      'credentials: Gateway cache request was not confirmed. Gateway may be unreachable, unauthorized, or incompatible; no local clear is Gateway success.',
    );
    options.setExitCode(1);
  }
}
