import interpolateEnvironmentValue from './interpolate-environment-value.ts';
import type { AgentManifest, ManifestDiagnostic } from './manifest-types.ts';

export interface AgentEnvironmentVariable {
  name: string;
  overriddenSources: AgentEnvironmentVariableSource[];
  required: boolean;
  source: AgentEnvironmentVariableSource;
}

export type AgentEnvironmentVariableSource =
  'environment.set' | `environment.dotenv[${number}]` | `environment.op[${number}]`;

export interface AgentEnvironmentInputSource {
  source: Exclude<AgentEnvironmentVariableSource, 'environment.set'>;
  sensitiveNames?: readonly string[];
  values: Record<string, string>;
}

export interface AgentEnvironmentExternalSources {
  dotenv?: readonly AgentEnvironmentInputSource[];
  onePassword?: readonly AgentEnvironmentInputSource[];
}

export interface ResolvedAgentEnvironment {
  sensitiveNames?: string[];
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

export const onePasswordServiceAccountTokenName = 'OP_SERVICE_ACCOUNT_TOKEN';

function sourceFieldPath(source: AgentEnvironmentVariableSource): string {
  const match = /^(environment\.(?:dotenv|op))\[(\d+)\]$/.exec(source);
  return match ? `/${match[1]?.replace('.', '/')}/${match[2]}` : '/environment/set';
}

/** Resolve one environment pass while keeping values separate from diagnostic metadata. */
export default function resolveAgentEnvironment(
  manifest: AgentManifest,
  referenceEnvironment: Readonly<Record<string, string | undefined>>,
  externalSources: AgentEnvironmentExternalSources = {},
): AgentEnvironmentResolution {
  const diagnostics: ManifestDiagnostic[] = [];
  const dotenvSources = externalSources.dotenv ?? [];
  const onePasswordSources = externalSources.onePassword ?? [];
  const inputSources = [...dotenvSources, ...onePasswordSources];
  const inputValues = new Map<string, string>();
  const inputSensitivity = new Map<string, boolean>();
  for (const { sensitiveNames = [], source, values } of inputSources) {
    const sensitive = new Set(sensitiveNames);
    for (const [name, value] of Object.entries(values)) {
      if (name === onePasswordServiceAccountTokenName) {
        diagnostics.push({
          code: 'environment-reserved-variable',
          fieldPath: sourceFieldPath(source),
          message: `${onePasswordServiceAccountTokenName} is reserved for Agent System bootstrap authentication and cannot be exported.`,
          severity: 'error',
        });
        continue;
      }
      inputValues.set(name, value);
      inputSensitivity.set(name, sensitive.has(name));
    }
  }
  const interpolationLookup = Object.fromEntries([
    ...Object.entries(referenceEnvironment).filter(
      (entry): entry is [string, string] =>
        entry[0] !== onePasswordServiceAccountTokenName && entry[1] !== undefined,
    ),
    ...inputValues,
  ]);
  const setSensitivity = new Map<string, boolean>();
  const setValues = Object.fromEntries(
    Object.entries(manifest.environment?.set ?? {}).flatMap(([name, input]) => {
      if (name === onePasswordServiceAccountTokenName) {
        diagnostics.push({
          code: 'environment-reserved-variable',
          fieldPath: `/environment/set/${name}`,
          message: `${onePasswordServiceAccountTokenName} is reserved for Agent System bootstrap authentication and cannot be exported.`,
          severity: 'error',
        });
        return [];
      }
      const interpolated = interpolateEnvironmentValue(input, interpolationLookup);
      const referencesBootstrapToken = interpolated.references.includes(
        onePasswordServiceAccountTokenName,
      );
      if (referencesBootstrapToken) {
        diagnostics.push({
          code: 'environment-reserved-reference',
          fieldPath: `/environment/set/${name}`,
          message: `${onePasswordServiceAccountTokenName} is reserved for Agent System bootstrap authentication and cannot be referenced by environment.set.`,
          severity: 'error',
        });
      }
      diagnostics.push(
        ...interpolated.missing
          .filter((reference) => reference !== onePasswordServiceAccountTokenName)
          .map((reference) => ({
            code: 'environment-reference-missing',
            fieldPath: `/environment/set/${name}`,
            message: `Environment variable ${name} references unavailable variable ${reference}.`,
            severity: 'error' as const,
          })),
      );
      setSensitivity.set(
        name,
        interpolated.references.some((reference) => inputSensitivity.get(reference) === true),
      );
      return [[name, interpolated.value] as const];
    }),
  );
  const values = new Map<string, string>();
  const provenance = new Map<string, AgentEnvironmentVariableSource[]>();
  const sensitivity = new Map<string, boolean>();
  const layers: Array<{
    sensitiveNames?: readonly string[];
    source: AgentEnvironmentVariableSource;
    values: Record<string, string>;
  }> = [
    ...dotenvSources,
    {
      sensitiveNames: [...setSensitivity].flatMap(([name, sensitive]) => (sensitive ? [name] : [])),
      source: 'environment.set',
      values: setValues,
    },
    ...onePasswordSources,
  ];
  for (const layer of layers) {
    const sensitive = new Set(layer.sensitiveNames ?? []);
    for (const [name, value] of Object.entries(layer.values)) {
      if (name === onePasswordServiceAccountTokenName) continue;
      values.set(name, value);
      provenance.set(name, [...(provenance.get(name) ?? []), layer.source]);
      sensitivity.set(name, sensitive.has(name));
    }
  }
  const required = new Set(manifest.environment?.required ?? []);
  if (required.has(onePasswordServiceAccountTokenName)) {
    diagnostics.push({
      code: 'environment-reserved-variable',
      fieldPath: '/environment/required',
      message: `${onePasswordServiceAccountTokenName} is reserved for Agent System bootstrap authentication and cannot be required as agent output.`,
      severity: 'error',
    });
  }
  diagnostics.push(
    ...[...required]
      .filter((name) => name !== onePasswordServiceAccountTokenName)
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
    environment: {
      ...([...sensitivity].some(([, sensitive]) => sensitive)
        ? {
            sensitiveNames: [...sensitivity]
              .flatMap(([name, sensitive]) => (sensitive ? [name] : []))
              .toSorted(),
          }
        : {}),
      values: Object.fromEntries(values),
      variables,
    },
  };
}
