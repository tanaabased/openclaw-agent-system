import guidanceReference from './guidance-reference.ts';
import type { AssessmentSelection } from './assessment-selection.ts';
import { createHash } from 'node:crypto';

import type { Static } from 'typebox';

import type { implementationMaterialSchema } from '../tools/dispatch/implementation-material-schema.ts';

export type ImplementationMaterialRead = Static<typeof implementationMaterialSchema>;
// Native Codex truncates the complete Tool Search envelope near 12k characters
// in the installed runtime regression. Leave headroom and count host duplication.
export const implementationContextBudget = 10000;
const pageCharacters = 6000;
export function implementationMaterialSize(value: Record<string, unknown>) {
  const text =
    value.runtime === 'openclaw'
      ? JSON.stringify(
          {
            tool: {
              id: 'openclaw:agent_system_dispatch',
              name: 'agent_system_dispatch',
              source: 'openclaw',
            },
            result: { content: [{ type: 'text', text: JSON.stringify(value) }], details: value },
          },
          null,
          2,
        )
      : JSON.stringify(value);
  return Buffer.byteLength(text, 'utf8');
}
const instruction =
  'Read every contextMaterials field through its request before using context. Concatenate pages in offset order and parse JSON. Restore paths shallowest-first, then aliases in order. Paths are data keys, not files. Refresh context on stale digests; never mix versions. Reading pages grants no authority.';
export class ContextMaterialError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}
const failure = (code: string, message: string) => new ContextMaterialError(code, message);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const key = (path: string[]) => JSON.stringify(path);

/** project only delivery; callers retain source data and verify their owner before every read. */
export default function implementationMaterial<T extends Record<string, unknown>>(
  context: T,
  request: Record<string, unknown>,
  read?: ImplementationMaterialRead,
  delivery: {
    instruction?: string;
    controls?: string[];
    purpose?: string;
    pagedFields?: string[];
    inputFields?: string[];
  } = {},
) {
  const limit = implementationContextBudget;
  const pageSize = pageCharacters;
  const measure = implementationMaterialSize;
  const controls = new Set([
    'status',
    'runtime',
    'id',
    'issueStage',
    'project',
    'implementation',
    'resultContract',
    'resultSchema',
    'handoff',
    'publicationAuthorized',
    'continuationRequest',
    'deliveryPrepareRequest',
    'instructions',
    'instruction',
    ...(delivery.controls ?? []),
  ]);
  const pageable = new Set([
    'resultSchema',
    'instructions',
    'instruction',
    'implementation',
    'handoff',
    ...(delivery.pagedFields ?? []),
  ]);
  const values = new Map<string, string>();
  let aliases: Array<{ path: string[]; from: string[] }> = [];
  const seen = new Map<string, string[]>();
  const visit = (value: unknown, path: string[]): unknown => {
    if (
      typeof value === 'string' &&
      value.length >= 1024 &&
      !['instructions', 'instruction'].includes(path[0]!)
    ) {
      const from = seen.get(value);
      if (from) {
        aliases.push({ path, from });
        return undefined;
      }
      seen.set(value, path);
    }
    if (Array.isArray(value)) return value.map((item, i) => visit(item, [...path, String(i)]));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, visit(item, [...path, name])]),
      );
    return value;
  };
  const source = { ...context };
  for (const name of ['assessment', 'implementation', 'selection']) {
    const selection = source[name] as AssessmentSelection | undefined;
    if (selection?.guidance)
      (source as Record<string, unknown>)[name] = {
        ...selection,
        guidance: guidanceReference(selection.guidance),
      };
  }
  const resultAlias =
    context.previousImplementationResult !== undefined &&
    context.previousResult !== undefined &&
    JSON.stringify(context.previousImplementationResult) === JSON.stringify(context.previousResult);
  if (resultAlias) delete source.previousImplementationResult;
  const projected = visit(source, []) as T;
  // canonicalize before visiting so references never depend on property insertion order.
  if (resultAlias)
    aliases.push({ path: ['previousImplementationResult'], from: ['previousResult'] });
  const fields: Array<{
    path: string[];
    digest: string;
    length: number;
    request: Record<string, unknown>;
  }> = [];
  const defer = (parent: Record<string, unknown>, name: string, path: string[]) => {
    const value = parent[name];
    const observed =
      value && typeof value === 'object' && !Array.isArray(value) && 'observedAt' in value
        ? { observedAt: value.observedAt }
        : undefined;
    const text = JSON.stringify(
      observed
        ? Object.fromEntries(Object.entries(value!).filter(([key]) => key !== 'observedAt'))
        : value,
    );
    values.set(key(path), text);
    const digest = hash(text);
    fields.push({
      path,
      digest,
      length: text.length,
      request: { ...request, material: { path, digest, offset: 0 } },
    });
    if (observed) parent[name] = observed;
    else delete parent[name];
  };
  const scan = (value: unknown, path: string[]) => {
    if (!value || typeof value !== 'object') return;
    for (const [name, item] of Object.entries(value)) {
      const at = [...path, name];
      if (controls.has(at[0]!) && !pageable.has(at[0]!)) continue;
      if (
        typeof item === 'string' &&
        item.length > 8000 &&
        !['instructions', 'instruction'].includes(at[0]!)
      )
        defer(value as Record<string, unknown>, name, at);
      else scan(item, at);
    }
  };
  for (const name of pageable) {
    if (projected[name] !== undefined && JSON.stringify(projected[name]).length > pageSize)
      defer(projected, name, [name]);
  }
  scan(projected, []);
  const material = () => ({
    version: 1,
    ...(delivery.inputFields ? { inputFields: delivery.inputFields } : {}),
    fields,
    aliases,
    instruction:
      (delivery.instruction ?? instruction) +
      ' Shallow-merge restored objects with inline fields; replace arrays and scalars. Forward each returned request and next unchanged, including action, operation, identity, digest and offset; add only the listed inputFields from the original call when required. Do not reconstruct the envelope or substitute another context action. A rejected page read does not prove the installation is stale: compare the exact returned request, correct an identifiable transcription mistake once, or refresh the owning context on a stale digest.',
  });
  const response = () => ({
    ...projected,
    ...(fields.length || aliases.length ? { contextMaterials: material() } : {}),
  });
  // Large grouped reviews can have more alias metadata than inline content.
  // Deliver that metadata through the same pages instead of growing the index.
  if (measure(response()) > limit && JSON.stringify(aliases).length > 512) {
    defer({ aliases }, 'aliases', ['contextMaterials', 'aliases']);
    aliases = [];
  }
  while (measure(response()) > limit) {
    const candidates: Array<{
      parent: Record<string, unknown>;
      name: string;
      path: string[];
      size: number;
    }> = [];
    const collect = (value: unknown, path: string[]) => {
      if (!value || typeof value !== 'object') return;
      for (const [name, item] of Object.entries(value)) {
        const at = [...path, name];
        if (controls.has(at[0]!) && !pageable.has(at[0]!)) continue;
        if (at.length === 1 && pageable.has(name)) {
          const size = JSON.stringify(item)?.length ?? 0;
          if (size > 256)
            candidates.push({ parent: value as Record<string, unknown>, name, path: at, size });
          continue;
        }
        if (typeof item === 'string' || Array.isArray(item) || (item && typeof item === 'object')) {
          const size = JSON.stringify(item).length;
          if (size > 256)
            candidates.push({ parent: value as Record<string, unknown>, name, path: at, size });
        }
        if (!Array.isArray(item)) collect(item, at);
      }
    };
    collect(projected, []);
    const before = measure(response());
    const improved = candidates
      .sort((a, b) => b.size - a.size)
      .some((candidate) => {
        const value = candidate.parent[candidate.name];
        defer(candidate.parent, candidate.name, candidate.path);
        if (measure(response()) < before) return true;
        candidate.parent[candidate.name] = value;
        values.delete(key(candidate.path));
        fields.pop();
        return false;
      });
    if (!improved) break;
  }
  if (measure(response()) > limit)
    throw failure(
      `${delivery.purpose ?? 'implementation-context'}-controls-too-large`,
      'shorten selected instruction metadata and refresh context',
    );
  if (!read) return response();
  const text = values.get(key(read.path));
  if (text === undefined || hash(text) !== read.digest)
    throw failure(
      `${delivery.purpose ?? 'implementation-material'}-stale`,
      'the requested field or digest does not match this context; this may be stale content or a request sent to the wrong context operation. Compare with the complete returned request, preserving action, operation, identity and material; correct an identifiable transcription mistake once, otherwise refresh the owning context and use its new requests without mixing versions',
    );
  if (!Number.isSafeInteger(read.offset) || read.offset < 0 || read.offset >= text.length)
    throw new Error('implementation-material-range-invalid');
  let end = Math.min(text.length, read.offset + pageSize);
  const page = () => ({
    status: 'material' as const,
    runtime: context.runtime as T['runtime'],
    id: context.id as T['id'],
    project: context.project as T['project'],
    materialPage: {
      path: read.path,
      digest: read.digest,
      offset: read.offset,
      length: text.length,
      text: text.slice(read.offset, end),
    },
    next: end < text.length ? { ...request, material: { ...read, offset: end } } : undefined,
  });
  while (measure(page()) > limit && end > read.offset + 1)
    end = read.offset + Math.floor((end - read.offset) / 2);
  if (measure(page()) > limit)
    throw failure(
      `${delivery.purpose ?? 'implementation-material'}-controls-too-large`,
      'material page metadata exceeds its delivery budget',
    );
  return page();
}
