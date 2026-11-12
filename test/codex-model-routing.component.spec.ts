import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import codexModelRouting from '../agent/models/codex-model-routing.ts';
import { bindCodexWorkspace } from '../agent/identity/codex-workspace-binding.ts';

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
    const changed = await codexModelRouting(data, {
      action: 'resolve',
      context: 'task',
      assessment: { complexity: 'unset', reason: 'No work tiers.' },
      fallback: 'default',
    });
    assert.ok('selection' in changed);
    assert.equal(changed.selection?.model, 'openai/changed');
  });

  it('should load current routing guidance from the bound workspace without copied digests', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-routing-')));
    roots.push(root);
    const data = join(root, 'data');
    await writeFile(
      join(root, 'agent.yaml'),
      'schema-version: 1\nagent: {id: bound}\nmodels:\n  default: {model: openai/example, effort: high}\n  routing: {skill: company:route, guidance: {file: routing.md}}\n',
    );
    await writeFile(join(root, 'routing.md'), 'Prefer localized work.');
    await bindCodexWorkspace(data, root);
    await writeFile(join(root, 'SKILL.md'), '# Custom routing\nAssess bounded work.');
    let enabled = true;
    const dependencies = {
      connect: async () => ({
        request: async (method: string) => {
          assert.equal(method, 'skills/list');
          return {
            data: [
              {
                cwd: root,
                errors: [],
                skills: [
                  { name: 'company:route', path: join(root, 'SKILL.md'), scope: 'user', enabled },
                ],
              },
            ],
          };
        },
        close: async () => {},
      }),
    };
    const inspected = await codexModelRouting(data, { action: 'inspect' }, dependencies);
    assert.ok('instructions' in inspected && inspected.instructions);
    assert.ok(inspected.instructions.guidance?.path);
    assert.equal('content' in inspected.instructions.guidance, false);
    assert.equal(
      await readFile(inspected.instructions.guidance.path, 'utf8'),
      'Prefer localized work.',
    );
    assert.equal(inspected.instructions.skill?.name, 'company:route');
    const request = {
      action: 'resolve',
      context: 'task',
      assessment: { complexity: 'unset', reason: 'Uncertain.' },
      fallback: 'default',
    };
    assert.equal((await codexModelRouting(data, request, dependencies)).status, 'unresolved');
    await writeFile(join(root, 'routing.md'), 'Changed instructions.');
    const changed = await codexModelRouting(data, request, dependencies);
    assert.ok('instructions' in changed && changed.instructions);
    assert.notEqual(changed.instructionsDigest, inspected.instructionsDigest);
    enabled = false;
    await assert.rejects(
      codexModelRouting(data, { action: 'inspect' }, dependencies),
      /skill-unavailable/,
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
