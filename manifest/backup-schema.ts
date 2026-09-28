import { Type, type Static } from 'typebox';

const pattern = Type.String({ minLength: 1, pattern: '^[^\\u0000\\r\\n]+$' });

export const externalBackupSchema = Type.Object(
  {
    output: Type.Optional(pattern),
    'git-ignore': Type.Optional(Type.Boolean()),
    'openclaw-state': Type.Optional(
      Type.Union([Type.Literal('auto'), Type.Literal('required'), Type.Literal('off')]),
    ),
    include: Type.Optional(Type.Array(pattern)),
    exclude: Type.Optional(Type.Array(pattern)),
  },
  { additionalProperties: false },
);

export interface BackupConfiguration {
  output?: string;
  gitIgnore?: boolean;
  openclawState?: 'auto' | 'required' | 'off';
  include?: string[];
  exclude?: string[];
}

/** decode only schema-owned keys, preserving literal selection patterns. */
export function decodeBackup(value: Static<typeof externalBackupSchema>): BackupConfiguration {
  return {
    ...(value.output === undefined ? {} : { output: value.output }),
    ...(value['git-ignore'] === undefined ? {} : { gitIgnore: value['git-ignore'] }),
    ...(value['openclaw-state'] === undefined ? {} : { openclawState: value['openclaw-state'] }),
    ...(value.include === undefined ? {} : { include: [...value.include] }),
    ...(value.exclude === undefined ? {} : { exclude: [...value.exclude] }),
  };
}
