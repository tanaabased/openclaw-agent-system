import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse, stringify } from 'smol-toml';

import { readCodexAutomations } from '../agent/automations/codex-automation-state.ts';

/** exercise both activation consumers against the same isolated saved-definition failures. */
export default async function checkCodexActivationIsolation(
  codexHome: string,
  nativeId: string,
  activate: () => Promise<unknown>,
  reconcile: () => Promise<unknown>,
) {
  const path = join(codexHome, 'automations', nativeId, 'automation.toml');
  const original = await readFile(path, 'utf8');
  const expected = await activate();
  const other = join(codexHome, 'automations', 'unrelated');
  await mkdir(other);
  try {
    for (const [contents, code] of [
      ['name = "unfinished', 'automation-saved-invalid'],
      ['version = 999\nprompt = "unrelated"\n', 'automation-saved-schema-unsupported'],
    ] as const) {
      await writeFile(join(other, 'automation.toml'), contents);
      assert.deepEqual(await activate(), expected);
      await assert.rejects(readCodexAutomations(codexHome), { code });
      await assert.rejects(readCodexAutomations(codexHome, { requireComplete: true }), { code });
      await assert.rejects(reconcile(), { code });
    }
  } finally {
    await rm(other, { recursive: true });
  }
  try {
    for (const [contents, code] of [
      ['name = "unfinished', 'automation-saved-invalid'],
      [stringify({ ...parse(original), version: 999 }), 'automation-saved-schema-unsupported'],
      [stringify({ ...parse(original), id: 'wrong-id' }), 'automation-saved-schema-unsupported'],
    ] as const) {
      await writeFile(path, contents);
      await assert.rejects(activate(), { code });
    }
    await rm(path);
    await assert.rejects(activate());
  } finally {
    await writeFile(path, original);
  }
  const duplicate = join(codexHome, 'automations', 'copied-owner');
  await mkdir(duplicate);
  try {
    const copied = { ...parse(original), id: 'copied-owner' };
    const encoded = stringify({ ...copied, prompt: 'encoded-prompt' }).replace(
      '"encoded-prompt"',
      JSON.stringify(parse(original).prompt).replaceAll('Managed by', '\\u004danaged by'),
    );
    for (const [index, contents] of [
      stringify(copied),
      stringify({ ...copied, version: 999 }),
      stringify(copied) + '\ninvalid = [',
      encoded,
      encoded.replaceAll('\\u004d', '\\U0000004d') + '\ninvalid = [',
    ].entries()) {
      await writeFile(join(duplicate, 'automation.toml'), contents);
      await assert.rejects(activate(), `copied ownership variant ${index}`);
    }
  } finally {
    await rm(duplicate, { recursive: true });
  }
  assert.deepEqual(await activate(), expected);
}
