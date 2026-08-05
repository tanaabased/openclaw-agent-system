import classifyOpenClawExecEnvironment, {
  type StaticExecDelivery,
} from './classify-openclaw-exec-environment.ts';
import interpolateEnvironmentValue from './interpolate-environment-value.ts';
import type { AgentManifest, ManifestDiagnostic } from './manifest-types.ts';

export interface AgentEnvironmentVariable {
  name: string;
  required: boolean;
  source: 'environment.set';
  staticExecDelivery: StaticExecDelivery;
}

export interface ResolvedAgentEnvironment {
  values: Record<string, string>;
  variables: AgentEnvironmentVariable[];
}

export type AgentEnvironmentResolution =
  | {
      status: 'invalid';
      diagnostics: ManifestDiagnostic[];
    }
  | {
      status: 'resolved';
      environment: ResolvedAgentEnvironment;
    };

/** Resolve one environment pass while keeping values separate from diagnostic metadata. */
export default function resolveAgentEnvironment(
  manifest: AgentManifest,
  referenceEnvironment: Readonly<Record<string, string | undefined>>,
): AgentEnvironmentResolution {
  const diagnostics: ManifestDiagnostic[] = [];
  const values = Object.fromEntries(
    Object.entries(manifest.environment?.set ?? {}).map(([name, input]) => {
      const interpolated = interpolateEnvironmentValue(input, referenceEnvironment);
      diagnostics.push(
        ...interpolated.missing.map((reference) => ({
          code: 'environment-reference-missing',
          fieldPath: `/environment/set/${name}`,
          message: `Environment variable ${name} references unavailable variable ${reference}.`,
          severity: 'error' as const,
        })),
      );
      return [name, interpolated.value];
    }),
  );
  const required = new Set(manifest.environment?.required ?? []);
  diagnostics.push(
    ...[...required]
      .filter((name) => values[name] === undefined || values[name] === '')
      .map((name) => ({
        code: 'environment-required-missing',
        fieldPath: '/environment/required',
        message: `Required environment variable ${name} is missing or empty.`,
        severity: 'error' as const,
      })),
  );
  if (diagnostics.length > 0) return { status: 'invalid', diagnostics };

  const variables = Object.keys(values)
    .toSorted()
    .map((name) => ({
      name,
      required: required.has(name),
      source: 'environment.set' as const,
      staticExecDelivery: classifyOpenClawExecEnvironment(name),
    }));

  return { status: 'resolved', environment: { values, variables } };
}
