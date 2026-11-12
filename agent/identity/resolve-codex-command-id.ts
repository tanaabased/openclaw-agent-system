import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

export interface ResolveCodexCommandAgentIdOptions {
  agentIds: readonly string[];
  codexHome: string;
  openClawStateDir?: string;
  resolveAgentDir(agentId: string): string;
  resolveStateDir(): string;
}

/** Match an OpenClaw-hosted Codex home and state profile to one configured agent. */
export default async function resolveCodexCommandAgentId(
  options: ResolveCodexCommandAgentIdOptions,
): Promise<string | undefined> {
  let canonicalCodexHome: string;
  try {
    canonicalCodexHome = await realpath(options.codexHome);
  } catch {
    return undefined;
  }

  if (options.openClawStateDir !== undefined) {
    let canonicalStateDir: string;
    let runtimeStateDir: string;
    try {
      [canonicalStateDir, runtimeStateDir] = await Promise.all([
        realpath(options.openClawStateDir),
        realpath(options.resolveStateDir()),
      ]);
    } catch {
      return undefined;
    }
    if (canonicalStateDir !== runtimeStateDir) return undefined;
  }

  for (const configuredAgentId of options.agentIds) {
    const agentId = configuredAgentId.trim().toLowerCase();
    if (!agentId) continue;
    const expectedCodexHome = await realpath(
      join(options.resolveAgentDir(agentId), 'codex-home'),
    ).catch(() => undefined);
    if (expectedCodexHome === canonicalCodexHome) return agentId;
  }
  return undefined;
}
