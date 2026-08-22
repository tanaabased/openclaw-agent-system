import type { ManifestDiagnostic } from './types.ts';
import type { ResolvableString } from './value-types.ts';

export type ManifestValueResolution =
  | {
      status: 'invalid';
      diagnostic: ManifestDiagnostic;
    }
  | {
      status: 'resolved';
      value: string;
    };

/** Resolve one declared configuration value from the completed Agent System environment. */
export default function resolveManifestValue(
  configuredValue: ResolvableString,
  environment: Readonly<Record<string, string | undefined>>,
  fieldPath: string,
): ManifestValueResolution {
  if (typeof configuredValue === 'string') {
    return { status: 'resolved', value: configuredValue };
  }

  const name = configuredValue.fromEnvironment;
  const value = environment[name];
  if (value === undefined || value === '') {
    return {
      status: 'invalid',
      diagnostic: {
        code: 'manifest-environment-value-missing',
        fieldPath,
        message: `Manifest field ${fieldPath} references missing or empty environment variable ${name}.`,
        severity: 'error',
      },
    };
  }

  return { status: 'resolved', value };
}
