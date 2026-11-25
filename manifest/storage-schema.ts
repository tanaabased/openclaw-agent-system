import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

const sqliteBackend = Type.Object(
  { type: Type.Literal('sqlite') },
  { additionalProperties: false },
);

export const externalStorageSchema = Type.Object(
  { backend: Type.Optional(Type.Union([Type.Literal('sqlite'), sqliteBackend])) },
  { additionalProperties: false },
);

export type StorageBackend = Static<typeof sqliteBackend>;

export function decodeStorageBackend(
  backend: NonNullable<Static<typeof externalStorageSchema>['backend']>,
): StorageBackend {
  return typeof backend === 'string' ? { type: backend } : backend;
}

/** Preserve absence so only Install initializes the shared setting. */
export function parseStorageConfig(storage: unknown): StorageBackend | undefined {
  if (storage === undefined) return;
  if (Value.Check(externalStorageSchema, storage)) {
    return storage.backend === undefined ? undefined : decodeStorageBackend(storage.backend);
  }
  if (
    storage &&
    typeof storage === 'object' &&
    'backend' in storage &&
    storage.backend === 'file'
  ) {
    throw new Error(
      'File workflow storage has been retired. Import existing records with the previous version before removing the storage.backend setting.',
    );
  }
  throw new Error('Set storage.backend to sqlite or { type: sqlite }.');
}
