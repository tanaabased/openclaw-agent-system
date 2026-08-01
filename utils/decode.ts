import camelCase from 'lodash-es/camelCase.js';
import camelcaseKeys from 'camelcase-keys';

type Decodable = null | undefined | string | string[] | Record<string, unknown>;

/** Decode dotted names and object keys from kebab-case to camelCase. */
export default function decode<T extends Decodable>(data: T): T {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    return data
      .split('.')
      .map((part) => camelCase(part))
      .join('.') as T;
  }

  if (Array.isArray(data)) {
    return data.map((property) =>
      property
        .split('.')
        .map((part) => camelCase(part))
        .join('.'),
    ) as T;
  }

  return camelcaseKeys(data, { deep: true });
}
