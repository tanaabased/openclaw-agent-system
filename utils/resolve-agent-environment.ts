import classifyOpenClawExecEnvironment, {
  type StaticExecDelivery,
} from './classify-openclaw-exec-environment.ts';
import type { AgentManifest } from './manifest-types.ts';

export interface AgentEnvironmentVariable {
  name: string;
  source: 'environment.set';
  staticExecDelivery: StaticExecDelivery;
}

export interface ResolvedAgentEnvironment {
  values: Record<string, string>;
  variables: AgentEnvironmentVariable[];
}

/** Resolve the literal environment while keeping values separate from diagnostic metadata. */
export default function resolveAgentEnvironment(manifest: AgentManifest): ResolvedAgentEnvironment {
  const values = { ...manifest.environment?.set };
  const variables = Object.keys(values)
    .toSorted()
    .map((name) => ({
      name,
      source: 'environment.set' as const,
      staticExecDelivery: classifyOpenClawExecEnvironment(name),
    }));

  return { values, variables };
}
