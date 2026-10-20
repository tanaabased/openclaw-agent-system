import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import codexModelRouting from '../agent/codex-model-routing.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('codex model routing binding', () => {
  it('should resolve only bound profiles without resolving declared secrets or applying setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-routing-'));
    roots.push(root);
    const workspace = join(root, 'bound');
    const data = join(root, 'data');
    await mkdir(workspace);
    const contents =
      'schema-version: 1\nagent:\n  id: bound\nmodels:\n  default: {model: openai/bound, effort: high}\nenvironment:\n  set:\n    SECRET: {from-op: "op://unavailable/item/password"}\n';
    await writeFile(join(workspace, 'agent.yaml'), contents);
    await bindCodexWorkspace(data, workspace);
    const inspected = await codexModelRouting(data, { action: 'inspect' });
    assert.ok('manifestDigest' in inspected);
    const result = await codexModelRouting(data, {
      action: 'resolve',
      manifestDigest: inspected.manifestDigest,
      context: 'Work in an unrelated target checkout.',
      assessment: { complexity: 'unset', reason: 'No work tiers configured.' },
      fallback: 'default',
    });
    assert.ok('selection' in result);
    assert.deepEqual(result.selection, { model: 'openai/bound', effort: 'high' });
    assert.equal(result.status, 'unresolved');
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal(await readFile(join(workspace, 'agent.yaml'), 'utf8'), contents);
    await writeFile(
      join(workspace, 'agent.yaml'),
      contents.replace('openai/bound', 'openai/changed'),
    );
    await assert.rejects(
      codexModelRouting(data, {
        action: 'resolve',
        manifestDigest: inspected.manifestDigest,
        context: 'task',
        assessment: { complexity: 'unset', reason: 'No work tiers.' },
        fallback: 'default',
      }),
      /profiles changed/,
    );
  });

  it('should distinguish absent binding from corrupt binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-routing-'));
    roots.push(root);
    assert.deepEqual(await codexModelRouting(root, { action: 'inspect' }), {
      status: 'unavailable',
      code: 'codex-workspace-unbound',
    });
    await writeFile(join(root, 'workspace-binding.json'), '{}');
    await assert.rejects(codexModelRouting(root, { action: 'inspect' }));
  });
});
