import interpolateEnvironmentValue from './interpolate-environment-value.ts';
import type { AgentManifest, ManifestDiagnostic } from './manifest-types.ts';

export interface AgentEnvironmentVariable {
  name: string;
  overriddenSources: AgentEnvironmentVariableSource[];
  required: boolean;
  source: AgentEnvironmentVariableSource;
}

export type AgentEnvironmentVariableSource = 'environment.set' | `environment.dotenv[${number}]`;

export interface AgentEnvironmentInputSource {
  source: Exclude<AgentEnvironmentVariableSource, 'environment.set'>;
  values: Record<string, string>;
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
  inputSources: readonly AgentEnvironmentInputSource[] = [],
): AgentEnvironmentResolution {
  const diagnostics: ManifestDiagnostic[] = [];
  const inputValues = new Map<string, string>();
  for (const { values } of inputSources) {
    for (const [name, value] of Object.entries(values)) inputValues.set(name, value);
  }
  const interpolationLookup = Object.fromEntries([
    ...Object.entries(referenceEnvironment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
    ...inputValues,
  ]);
  const setValues = Object.fromEntries(
    Object.entries(manifest.environment?.set ?? {}).map(([name, input]) => {
      const interpolated = interpolateEnvironmentValue(input, interpolationLookup);
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
  const values = new Map<string, string>();
  const provenance = new Map<string, AgentEnvironmentVariableSource[]>();
  const layers: Array<{
    source: AgentEnvironmentVariableSource;
    values: Record<string, string>;
  }> = [...inputSources, { source: 'environment.set', values: setValues }];
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer.values)) {
      values.set(name, value);
      provenance.set(name, [...(provenance.get(name) ?? []), layer.source]);
    }
  }
  const required = new Set(manifest.environment?.required ?? []);
  diagnostics.push(
    ...[...required]
      .filter((name) => !values.has(name) || values.get(name) === '')
      .map((name) => ({
        code: 'environment-required-missing',
        fieldPath: '/environment/required',
        message: `Required environment variable ${name} is missing or empty.`,
        severity: 'error' as const,
      })),
  );
  if (diagnostics.length > 0) return { status: 'invalid', diagnostics };

  const variables = [...values.keys()].toSorted().map((name) => {
    const sources = provenance.get(name) ?? [];
    const source = sources.at(-1);
    if (!source) throw new Error(`Environment variable ${name} has no provenance.`);
    return {
      name,
      overriddenSources: sources.slice(0, -1),
      required: required.has(name),
      source,
    };
  });

  return {
    status: 'resolved',
    environment: { values: Object.fromEntries(values), variables },
  };
}
