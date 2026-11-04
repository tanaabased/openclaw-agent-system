import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hostRequire = createRequire(require.resolve('openclaw/plugin-sdk/plugin-entry'));
const { marked } = await import(hostRequire.resolve('marked'));
const body = await readFile(process.argv[2], 'utf8');
const blocks = marked.lexer(body).filter((token) => token.type !== 'space');
assert.deepEqual(
  blocks.map((token) => token.type),
  ['blockquote', 'blockquote', 'blockquote', 'blockquote', 'paragraph', 'paragraph'],
);
for (const [index, source] of ['alpha', 'beta', 'gamma', 'delta'].entries()) {
  const card = blocks[index];
  assert.equal(card.tokens[0].type, 'heading');
  assert.equal(card.tokens[0].text, `${index === 0 ? '⚠️' : '✅'} Source ${source}`);
  assert.equal(card.tokens.filter((token) => token.type === 'heading').length, 1);
}
assert.ok(blocks[4].text.startsWith('**Runner result:** ✅ success · Exit 0'));
assert.ok(blocks[5].text.startsWith('**Run:**'));
assert.equal((marked.parse(body).match(/<blockquote>/gu) ?? []).length, 4);
