import assert from 'node:assert/strict';

import { implementationContextBudget } from '../agent/implementation-material.ts';

export type Field = {
  path: string[];
  digest: string;
  length: number;
  request: Record<string, unknown>;
};
type Materials = { fields: Field[]; aliases: Array<{ path: string[]; from: string[] }> };

/** reconstruct the delivered source through native requests, never by reading the journal. */
export default async function hydrateImplementation(
  response: object,
  run: (request: Record<string, unknown>) => Promise<object>,
) {
  assert.ok(JSON.stringify(response).length <= implementationContextBudget);
  const output = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
  const materials = output.contextMaterials as Materials | undefined;
  if (!materials) return output;
  const locate = (path: string[]) => {
    let parent = output;
    for (const name of path.slice(0, -1)) {
      parent[name] ??= {};
      parent = parent[name] as Record<string, unknown>;
    }
    return { parent, name: path.at(-1)! };
  };
  for (const field of [...materials.fields].sort((a, b) => a.path.length - b.path.length)) {
    let request: Record<string, unknown> | undefined = field.request;
    let text = '';
    while (request) {
      const page = (await run(request)) as Record<string, unknown>;
      assert.equal(page.status, 'material');
      assert.ok(JSON.stringify(page).length <= implementationContextBudget);
      const value = page.materialPage as { offset: number; digest: string; text: string };
      assert.equal(value.digest, field.digest);
      assert.equal(value.offset, text.length);
      text += value.text;
      request = page.next as Record<string, unknown> | undefined;
    }
    assert.equal(text.length, field.length);
    const { parent, name } = locate(field.path);
    parent[name] = JSON.parse(text);
  }
  for (const alias of materials.aliases) {
    const source = locate(alias.from);
    const destination = locate(alias.path);
    destination.parent[destination.name] = source.parent[source.name];
  }
  delete output.contextMaterials;
  return output;
}
