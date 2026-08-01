import { createRequire } from 'node:module';

import isPlainObject from 'lodash-es/isPlainObject.js';

interface KebabcaseKeysOptions {
  readonly deep?: boolean;
  readonly exclude?: ReadonlyArray<string | RegExp>;
}

type KebabcaseKeys = <T>(input: T, options?: KebabcaseKeysOptions) => T;

const loadPackage = createRequire(import.meta.url);
const kebabcaseKeys = loadPackage('kebabcase-keys') as KebabcaseKeys;

/** Convert plain-object keys to kebab-case without mutating the input. */
export default function encodeKeys<T>(data: T): T {
  if (!isPlainObject(data)) return data;

  return kebabcaseKeys(data, {
    deep: true,
    exclude: [new RegExp('(^@).*/')],
  });
}
