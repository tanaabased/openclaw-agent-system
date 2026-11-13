import { nativeObject } from '../../utils/native-object.ts';
import { parseMemoryStatus, type MemoryStatus } from './memory-status.ts';

export type MemoryIndexStatus = MemoryStatus['status'] & { health?: 'ready' | 'degraded' };
export type MemoryEmbeddingStatus = {
  provider: string;
  fallback?: MemoryStatus['status']['fallback'];
  probe?: MemoryStatus['embeddingProbe'];
};

export type MemoryStatusDependencies = {
  readCli(): Promise<{ code: number | null; stdout: string; stderr: string }>;
  request(
    method: 'memory.status' | 'doctor.memory.status',
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

async function readOfflineStatus(
  agentId: string,
  dependencies: MemoryStatusDependencies,
): Promise<MemoryStatus | undefined> {
  const result = await dependencies.readCli();
  // only the explicit offline-owner refusal selects online diagnostics.
  if (
    result.stderr.includes('Cannot admit memory.cli for memory stores') &&
    result.stderr.includes('This operation requires exclusive offline state ownership.')
  )
    return undefined;
  try {
    return parseMemoryStatus(result.stdout, agentId);
  } catch {
    throw new Error('OpenClaw returned no agent-scoped memory status evidence.');
  }
}

export default async function inspectMemoryIndex(
  agentId: string,
  dependencies: MemoryStatusDependencies,
): Promise<MemoryIndexStatus> {
  const offline = await readOfflineStatus(agentId, dependencies);
  if (offline) return offline.status;
  const health = await dependencies.request('memory.status', { agentId });
  const details = nativeObject(health.details) ? health.details.legacy : undefined;
  if (
    health.agentId !== agentId ||
    health.version !== 2 ||
    health.providerId !== 'memory-core' ||
    !nativeObject(details) ||
    !['ready', 'degraded'].includes(String(health.status))
  )
    throw new Error('OpenClaw returned no matching built-in memory index evidence.');
  const parsed = parseMemoryStatus(JSON.stringify([{ agentId, status: details }]), agentId);
  return { ...parsed.status, health: health.status as 'ready' | 'degraded' };
}

export async function inspectMemoryEmbedding(
  agentId: string,
  dependencies: MemoryStatusDependencies,
): Promise<MemoryEmbeddingStatus> {
  const offline = await readOfflineStatus(agentId, dependencies);
  if (offline)
    return {
      provider: offline.status.provider,
      probe: offline.embeddingProbe,
      ...(offline.status.fallback ? { fallback: offline.status.fallback } : {}),
    };
  const result = await dependencies.request('doctor.memory.status', { agentId, probe: true });
  if (
    result.agentId !== agentId ||
    !nativeObject(result.embedding) ||
    typeof result.embedding.ok !== 'boolean' ||
    (result.embedding.ok && typeof result.provider !== 'string')
  )
    throw new Error('OpenClaw returned invalid agent-scoped embedding evidence.');
  const parsed = parseMemoryStatus(
    JSON.stringify([
      {
        agentId,
        status: { provider: result.provider ?? 'unavailable' },
        embeddingProbe: result.embedding,
      },
    ]),
    agentId,
  );
  return { provider: parsed.status.provider, probe: parsed.embeddingProbe };
}
