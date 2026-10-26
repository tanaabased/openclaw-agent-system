import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

import codexDispatchHandoff from '../agent/codex-dispatch-handoff.ts';

describe('agent/codex-dispatch-handoff process transport', () => {
  it('should reuse the saved launcher after removing its original node installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scheduled-node-upgrade-'));
    try {
      const bin = join(root, 'bin');
      await mkdir(bin);
      const previous = join(root, 'previous-node');
      const replacement = join(root, 'replacement-node');
      const node = join(bin, 'node');
      await symlink(process.execPath, previous);
      await symlink(process.execPath, replacement);
      await symlink(previous, node);
      const entrypoint = join(root, "plugin's runtime.cjs");
      // only the transport is under test; no live intake or native scheduler is invoked.
      await writeFile(
        entrypoint,
        'process.stdout.write(JSON.stringify({status:"ready", action:process.argv[3], executable:process.execPath}));\n',
      );
      const identity = {
        nodeExecutable: previous,
        entrypoint,
        pluginData: join(root, 'private data'),
      };
      const saved = codexDispatchHandoff(identity);
      assert.doesNotMatch(saved, new RegExp(previous));
      assert.equal(
        codexDispatchHandoff({ ...identity, nodeExecutable: replacement } as typeof identity),
        saved,
      );
      const output: { exit_code: number; output: string }[] = [];
      const context = {
        runtimeRoute: 'intake',
        runtimeInput: {},
        load: () => undefined,
        store: () => {},
        text: (value: { exit_code: number; output: string }) => output.push(value),
        tools: {
          exec_command: async ({ cmd }: { cmd: string }) => {
            const result = spawnSync('/bin/sh', ['-c', cmd], {
              env: { ...process.env, PATH: bin },
              encoding: 'utf8',
              timeout: 10000,
            });
            assert.ifError(result.error);
            return { exit_code: result.status, output: result.stdout + result.stderr };
          },
        },
      };
      const run = (action: string) => {
        context.runtimeInput = { action };
        return runInNewContext('(async () => {' + saved + '})()', context);
      };
      await run('scan');
      await rm(node);
      await symlink(replacement, node);
      await rm(previous);
      const baseline = spawnSync(previous, [entrypoint], { encoding: 'utf8' });
      assert.equal((baseline.error as NodeJS.ErrnoException)?.code, 'ENOENT');
      for (const action of ['scan', 'failure-response']) {
        await run(action);
        assert.equal(output.at(-1)!.exit_code, 0);
        assert.equal(JSON.parse(output.at(-1)!.output).action, action);
      }
      await rm(node);
      await assert.rejects(run('scan'), /codex-node-unavailable:.*PATH/u);
      await assert.rejects(run('failure-response'), /codex-node-unavailable:.*formatter/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
