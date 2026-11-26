import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import runDeclaredTool from '../tools/declared/run.ts';

describe('declared tool execution', () => {
  it('rejects stale declarations, denied calls and missing targets before credential resolution', async () => {
    let lookups = 0;
    let launches = 0;
    const binding = {
      workspace: tmpdir(),
      cwd: tmpdir(),
      hostPath: '/bin',
      hostExclusions: [],
      shimDirectories: [],
      baseline: {},
      declarations: { site: { executable: process.execPath, environment: ['VALUE'] } },
      async authorize() {},
      async resolveValues() {
        lookups++;
        return {};
      },
      async run() {
        launches++;
        throw new Error('unexpected launch');
      },
    };
    const input = { id: 'site', argv: [] };
    await assert.rejects(runDeclaredTool(input, { ...binding, declarations: {} }), {
      code: 'tool_unavailable',
    });
    await assert.rejects(
      runDeclaredTool(input, {
        ...binding,
        authorize: async () => {
          throw new Error('denied');
        },
      }),
      /denied/,
    );
    await assert.rejects(
      runDeclaredTool(input, {
        ...binding,
        declarations: { site: { executable: 'missing-test-cli', environment: ['VALUE'] } },
      }),
      { code: 'tool_unavailable' },
    );
    assert.equal(lookups, 0);
    await assert.rejects(runDeclaredTool(input, binding), { code: 'credential_unavailable' });
    assert.equal(lookups, 1);
    assert.equal(launches, 0);
  });

  it('preserves arguments, scopes selected values to the child and accepts target edits', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'declared-tool-'));
    try {
      const script = join(workspace, 'command');
      const write = (version: string) =>
        writeFile(
          script,
          '#!/bin/sh\n[ "$SELECTED_TEST_VALUE" = fixture ] && [ -z "${UNRELATED_TEST_VALUE+x}" ] || exit 1\nprintf "%s:%s" ' +
            version +
            ' "$1"\n',
          { mode: 0o700 },
        );
      const invoke = () =>
        runDeclaredTool(
          { id: 'site', argv: ['a b; $HOME'] },
          {
            workspace,
            cwd: workspace,
            hostPath: '/bin',
            hostExclusions: [],
            shimDirectories: [],
            baseline: {},
            declarations: {
              site: { executable: './command', environment: ['SELECTED_TEST_VALUE'] },
            },
            async authorize() {},
            async resolveValues(names) {
              assert.deepEqual(names, ['SELECTED_TEST_VALUE']);
              return { SELECTED_TEST_VALUE: 'fixture', UNRELATED_TEST_VALUE: 'unrelated' };
            },
            async run(request) {
              const { stdout, stderr } = await promisify(execFile)(
                request.executable,
                request.argv,
                { cwd: request.cwd, env: request.environment },
              );
              return { stdout, stderr, exitCode: 0, timedOut: false, truncated: false };
            },
          },
        );
      const original = process.env.SELECTED_TEST_VALUE;
      await write('before');
      assert.equal((await invoke()).stdout, 'before:a b; $HOME');
      await write('after');
      assert.equal((await invoke()).stdout, 'after:a b; $HOME');
      assert.equal(process.env.SELECTED_TEST_VALUE, original);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
