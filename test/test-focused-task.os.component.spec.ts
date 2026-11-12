import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('scripts/test-focused-task', () => {
  let root: string;
  let first: string;
  let second: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'focused-tests-')));
    first = join(root, 'first.component.spec.ts');
    second = join(root, 'second.os.component.spec.ts');
    await writeFile(
      first,
      `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(join(root, 'executed'))}, 'selected');
describe('selected first', () => { it('should run the first selected case', () => {}); });`,
    );
    await writeFile(
      second,
      "describe('selected second', () => { it('should run the second selected case', () => {}); });",
    );
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const run = (args: string[]) => {
    const result = spawnSync('bun', [resolve('scripts/test-focused-task.ts'), ...args], {
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    return { status: result.status, output: result.stdout + result.stderr };
  };

  it('should build once and run only the explicit portable and os files', () => {
    const result = run(['--build', first, second]);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /2 passing/);
    assert.equal(result.output.split('$ bun scripts/build-task.ts').length - 1, 1);
  });

  it('should fail missing selections before building or running any valid file', async () => {
    for (const args of [[], [first, join(root, 'missing.component.spec.ts')]]) {
      const result = run(['--build', ...args]);
      assert.notEqual(result.status, 0, result.output);
      assert.doesNotMatch(result.output, /\$ bun scripts\/build-task.ts/);
      await assert.rejects(access(join(root, 'executed')), { code: 'ENOENT' });
    }
  });

  it('should fail zero matches without expanding the explicit selection', async () => {
    const empty = join(root, 'empty.component.spec.ts');
    await writeFile(empty, 'export {};');
    for (const args of [[empty], [first, '--grep', 'absent-case']]) {
      const result = run(args);
      assert.notEqual(result.status, 0, result.output);
      assert.match(result.output, /0 passing/);
    }
    const selected = run([first, second, '--grep', 'second selected']);
    assert.equal(selected.status, 0, selected.output);
    assert.match(selected.output, /1 passing/);
    assert.doesNotMatch(selected.output, /should run the first selected case/);
  });
});
