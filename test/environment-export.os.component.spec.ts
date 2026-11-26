import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { type AgentSystemLifecycleExecutionContext } from '../core/lifecycle-registry.ts';
import createEnvironmentExportLifecycle from '../environment/export-lifecycle.ts';

describe('environment/export-lifecycle', () => {
  let workspace: string;
  let values: Record<string, string>;
  let resolutions: number;
  const exportLifecycle = createEnvironmentExportLifecycle({
    target: () => ({ root: workspace, owner: ['binding', workspace] }),
    async resolve() {
      resolutions++;
      return { status: 'resolved', environment: { values, variables: [] } };
    },
  });

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'environment-export-'));
    resolutions = 0;
    values = {
      EMPTY: '',
      PAYLOAD:
        ' spaces \' and "quotes" \\\n$HOME $(>unexpected-substitution) `>unexpected-backticks` !\n',
      UNSELECTED: 'only in the resolver',
    };
  });

  afterEach(async () => rm(workspace, { force: true, recursive: true }));

  function context(variables: string[], path?: string): AgentSystemLifecycleExecutionContext {
    return {
      workspaceDir: workspace,
      runtime: 'codex',
      manifest: {
        schemaVersion: 1,
        agent: { id: 'example' },
        environment: { export: { variables, path } },
      },
    };
  }

  for (const [shell, flags] of [
    ['/bin/bash', ['--noprofile', '--norc']],
    ['/bin/zsh', ['-f']],
  ] as const) {
    it(
      'should source exact child environment values in ' + shell.split('/').at(-1),
      async function () {
        try {
          await access(shell, 1);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || shell !== '/bin/zsh')
            throw error;
          this.skip();
        }
        const result = await exportLifecycle.reconcile(context(['PAYLOAD', 'EMPTY']));
        const path = result.outcomes[0]!.message;
        const child = spawnSync(
          shell,
          [
            ...flags,
            '-ec',
            'typeset -i PAYLOAD=1; . "$1"; "$2" -e \'console.log(JSON.stringify([process.env.PAYLOAD, process.env.EMPTY, process.env.UNSELECTED]))\'',
            shell,
            path,
            process.execPath,
          ],
          { cwd: workspace, env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' },
        );
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), [values.PAYLOAD, '', null]);
        await assert.rejects(access(join(workspace, 'unexpected-substitution')), {
          code: 'ENOENT',
        });
        await assert.rejects(access(join(workspace, 'unexpected-backticks')), { code: 'ENOENT' });
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
      },
    );
  }

  it('should inspect without resolving values and preserve the previous export if refresh fails', async () => {
    const before = context(['PAYLOAD', 'EMPTY']);
    assert.equal((await exportLifecycle.inspect(before))[0]?.code, 'environment-export-missing');
    assert.equal(resolutions, 0);
    assert.deepEqual(await readdir(workspace), []);
    const initial = await exportLifecycle.reconcile(before);
    const path = initial.outcomes[0]!.message;
    const snapshot = await readFile(path, 'utf8');
    const next = context(['EMPTY']);
    assert.equal((await exportLifecycle.inspect(next))[0]?.code, 'environment-export-drift');
    assert.equal(resolutions, 1);
    assert.equal(await readFile(path, 'utf8'), snapshot);

    // fail the final ownership recheck, after the temporary file has been written.
    let checks = 0;
    await assert.rejects(
      exportLifecycle.reconcile({
        ...next,
        assertCurrent: async () => {
          if (++checks >= 2) throw new Error('changed manifest');
        },
      }),
      /changed manifest/u,
    );
    assert.equal(await readFile(path, 'utf8'), snapshot);
    assert.equal((await readdir(dirname(path))).length, 1);

    await assert.rejects(exportLifecycle.reconcile(context(['MISSING'])), {
      code: 'environment-export-value-unavailable',
    });
    assert.equal(await readFile(path, 'utf8'), snapshot);

    await exportLifecycle.reconcile(next);
    const refreshed = await readFile(path, 'utf8');
    assert.doesNotMatch(refreshed, /PAYLOAD/u);
    assert.equal((await exportLifecycle.reconcile(next)).outcomes[0]?.status, 'unchanged');
    await chmod(path, 0o644);
    assert.equal((await exportLifecycle.inspect(next))[0]?.code, 'environment-export-drift');
    assert.equal((await stat(path)).mode & 0o777, 0o644);
    await exportLifecycle.reconcile(next);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await exportLifecycle.inspect(next))[0]?.status, 'healthy');
    await exportLifecycle.reconcile(context([]));
    assert.doesNotMatch(await readFile(path, 'utf8'), /builtin export/u);
  });

  it('should preserve unrelated files and symlinks at a custom destination', async () => {
    await mkdir(join(workspace, 'exports'));
    const path = join(workspace, 'exports', 'shell.sh');
    const custom = context(['PAYLOAD'], 'exports/shell.sh');
    await writeFile(path, 'operator setup\n', { mode: 0o600 });
    await assert.rejects(exportLifecycle.reconcile(custom), {
      code: 'environment-export-target-foreign',
    });
    assert.equal(await readFile(path, 'utf8'), 'operator setup\n');
    assert.equal((await exportLifecycle.inspect(custom))[0]?.status, 'blocked');
    await rm(path);
    const target = join(workspace, 'untouched');
    await writeFile(target, 'keep\n');
    await symlink(target, path);
    await assert.rejects(exportLifecycle.reconcile(custom), {
      code: 'environment-export-target-unsafe',
    });
    assert.equal(await readFile(path, 'utf8'), 'keep\n');
  });
});
