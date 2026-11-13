import { Value } from 'typebox/value';
import { automationHash } from '../../automation-hash.ts';
import { nativeObject } from '../../../utils/native-object.ts';
import { modelMaterialSchema } from '../../../tools/dispatch/implementation-material-schema.ts';

export function materialScope(route: string, input: Record<string, unknown>) {
  const semantic = { ...input };
  delete semantic.material;
  if (route === 'intake') delete semantic.action;
  return automationHash({ route, input: semantic });
}

export function assertModelMaterial(input: Record<string, unknown>) {
  if (input.material !== undefined && !Value.Check(modelMaterialSchema, input.material))
    throw new Error('material-model-request-invalid');
}

/** Keep page requests on the public route when an adapter delegates to another owner. */
export function routeMaterialResponse<T>(value: T, request: Record<string, unknown>): T {
  if (!nativeObject(value)) return value;
  const page = (input: unknown) =>
    nativeObject(input) && nativeObject(input.material)
      ? { ...request, material: input.material }
      : input;
  const materials = value.contextMaterials;
  return {
    ...value,
    ...(nativeObject(materials) && Array.isArray(materials.fields)
      ? {
          contextMaterials: {
            ...materials,
            fields: materials.fields.map((field: unknown) =>
              nativeObject(field) ? { ...field, request: page(field.request) } : field,
            ),
          },
        }
      : {}),
    ...(value.next ? { next: page(value.next) } : {}),
  } as T;
}

/** Native receipts carry the version; model-facing next requests carry only a field and offset. */
export function nativeMaterialResponse<T>(
  value: T,
  route: string,
  input: Record<string, unknown>,
): T {
  if (!nativeObject(value) || (!value.contextMaterials && !value.materialPage)) return value;
  const pageRequest = (request: unknown) => {
    if (!nativeObject(request) || !nativeObject(request.material)) return request;
    const material = { ...request.material };
    delete material.digest;
    return { ...request, material };
  };
  const response: Record<string, unknown> = {
    ...value,
    ...(value.materialPage ? { materialScope: materialScope(route, input) } : {}),
  };
  const materials = value.contextMaterials;
  if (nativeObject(materials) && Array.isArray(materials.fields))
    response.contextMaterials = {
      ...materials,
      fields: materials.fields.map((field: unknown) =>
        nativeObject(field) && nativeObject(field.request)
          ? {
              ...field,
              materialScope: materialScope(route, {
                ...Object.fromEntries(
                  (Array.isArray(materials.inputFields) ? materials.inputFields : []).map(
                    (key: string) => [key, input[key]],
                  ),
                ),
                ...field.request,
              }),
              request: pageRequest(field.request),
            }
          : field,
      ),
    };
  if (value.next) response.next = pageRequest(value.next);
  return response as T;
}

/** Results must be supplied newest-first by a native receipt adapter, never by tool arguments. */
export async function bindNativeMaterial(
  route: string,
  input: Record<string, unknown>,
  receipts: AsyncIterable<unknown>,
) {
  assertModelMaterial(input);
  if (!input.material) return input;
  const read = input.material as { path: string[]; offset: number };
  const scope = materialScope(route, input);
  const samePath = (path: unknown) => automationHash(path) === automationHash(read.path);
  for await (const result of receipts) {
    if (!nativeObject(result)) continue;
    const page = result.materialPage;
    if (
      result.materialScope === scope &&
      nativeObject(page) &&
      samePath(page.path) &&
      typeof page.digest === 'string'
    )
      return { ...input, material: { ...read, digest: page.digest } };
    const materials = result.contextMaterials;
    if (!nativeObject(materials) || !Array.isArray(materials.fields)) continue;
    const field = materials.fields.find(
      (field: unknown) =>
        nativeObject(field) && field.materialScope === scope && samePath(field.path),
    );
    if (!nativeObject(field) || typeof field.digest !== 'string') continue;
    // A fresh context response supersedes older page streams; start its field from the beginning.
    if (read.offset !== 0)
      throw new Error('material-version-refreshed: restart this field at offset 0');
    return { ...input, material: { ...read, digest: field.digest } };
  }
  throw new Error(
    'material-native-response-unavailable: refresh the owning context before reading pages',
  );
}
