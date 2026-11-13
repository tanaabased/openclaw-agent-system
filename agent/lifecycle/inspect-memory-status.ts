import { nativeObject } from '../../utils/native-object.ts';
import { parseMemoryStatus, type MemoryStatus } from './memory-status.ts';

type MemoryStatusDependencies = {
  readCli(): Promise<{ code: number | null; stdout: string; stderr: string }>;
  request(
    method: 'memory.status' | 'doctor.memory.status',
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

export default async function inspectMemoryStatus(
  agentId: string,
  deep: boolean,
  dependencies: MemoryStatusDependencies,
): Promise<MemoryStatus> {
  const result = await dependencies.readCli();
  // only the explicit offline-owner refusal selects online diagnostics; other failures stay failures.
  if (
    !result.stderr.includes('Cannot admit memory.cli for memory stores') ||
    !result.stderr.includes('This operation requires exclusive offline state ownership.')
  ) {
    try {
      return parseMemoryStatus(result.stdout, agentId);
    } catch {
      throw new Error(result.stderr.trim() || `OpenClaw memory status exited ${result.code}.`);
    }
  }

  const probe = deep
    ? await dependencies.request('doctor.memory.status', { agentId, probe: true })
    : undefined;
  if (
    probe &&
    (probe.agentId !== agentId ||
      !nativeObject(probe.embedding) ||
      typeof probe.embedding.ok !== 'boolean')
  ) {
    throw new Error('OpenClaw returned invalid agent-scoped embedding evidence.');
  }
  // read index evidence after the probe, which may initialize the embedding provider.
  const health = await dependencies.request('memory.status', { agentId });
  const details = nativeObject(health.details) ? health.details.legacy : undefined;
  if (
    health.agentId !== agentId ||
    health.version !== 2 ||
    health.providerId !== 'memory-core' ||
    !nativeObject(details) ||
    (probe?.provider !== undefined && probe.provider !== details.provider)
  ) {
    throw new Error('OpenClaw returned no matching built-in memory readiness evidence.');
  }
  const status = parseMemoryStatus(
    JSON.stringify([
      { agentId, status: details, ...(probe ? { embeddingProbe: probe.embedding } : {}) },
    ]),
    agentId,
  );
  // an aggregate warning must not disappear merely because its detailed fields are incomplete.
  if (health.status !== 'ready') {
    throw new Error('OpenClaw memory health is unavailable.');
  }
  return status;
}
