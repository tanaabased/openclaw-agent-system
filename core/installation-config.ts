import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { Type } from 'typebox';
import { Value } from 'typebox/value';

import installationConfigRoot from './installation-config-root.ts';
import PrivateStateFile from './private-state-file.ts';
import { parseManifestYaml } from '../manifest/parse.ts';

const schema = Type.Object(
  {
    'schema-version': Type.Literal(1),
    cleanup: Type.Optional(
      Type.Object(
        { 'grace-minutes': Type.Optional(Type.Integer({ minimum: 0, maximum: 43_200 })) },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type InstallationConfig =
  | {
      status: 'ready';
      path: string;
      graceMinutes: number;
      source: 'default' | 'file';
      digest: string;
    }
  | {
      status: 'blocked';
      path?: string;
      code: 'retirement-configuration-unavailable' | 'retirement-configuration-invalid';
    };

export function parseInstallationConfig(
  source: string | undefined,
  path: string,
): InstallationConfig {
  const parsed = source === undefined ? undefined : parseManifestYaml(source);
  if (parsed && (parsed.status !== 'valid' || !Value.Check(schema, parsed.value)))
    return { status: 'blocked', path, code: 'retirement-configuration-invalid' };
  const value =
    parsed?.status === 'valid' && Value.Check(schema, parsed.value) ? parsed.value : undefined;
  return {
    status: 'ready',
    path,
    graceMinutes: value?.cleanup?.['grace-minutes'] ?? 60,
    source: value?.cleanup?.['grace-minutes'] === undefined ? 'default' : 'file',
    digest: createHash('sha256')
      .update(path)
      .update('\0')
      .update(source ?? '<missing>')
      .digest('hex'),
  };
}

/** passive, bounded reads; a present but broken file never falls back to the default. */
export default async function readInstallationConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  read?: (path: string) => Promise<string | undefined>,
): Promise<InstallationConfig> {
  const root = installationConfigRoot(environment);
  if (!root) return { status: 'blocked', code: 'retirement-configuration-unavailable' };
  const path = join(root, 'config.yaml');
  try {
    const contents = await (read
      ? read(path)
      : new PrivateStateFile({
          path,
          directories: [root],
          label: 'installation configuration',
          maximumBytes: 65_536,
          currentUid: process.getuid?.(),
        }).read());
    return parseInstallationConfig(contents, path);
  } catch {
    return { status: 'blocked', path, code: 'retirement-configuration-unavailable' };
  }
}
