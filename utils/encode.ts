import kebabCase from 'lodash-es/kebabCase.js';

import encodeKeys from './encode-keys.ts';

type Encodable = null | undefined | string | string[] | Record<string, unknown>;

/** Encode dotted names and object keys from camelCase to kebab-case. */
export default function encode<T extends Encodable>(data: T): T {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    return data
      .split('.')
      .map((part) => kebabCase(part))
      .join('.') as T;
  }

  if (Array.isArray(data)) {
    return data.map((property) =>
      property
        .split('.')
        .map((part) => kebabCase(part))
        .join('.'),
    ) as T;
  }

  return encodeKeys(data);
}
