import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { googleCommandContract } from '../tools/google/command-contract.ts';
import { parseGoogleCommand, validateGoogleFiles } from '../tools/google/command.ts';

describe('google command containment', () => {
  it('should keep the admitted flags within the captured upstream v0.42.0 schema', async () => {
    const upstream = JSON.parse(
      await readFile(new URL('./google-upstream-contract.json', import.meta.url), 'utf8'),
    );
    for (const [command, contract] of Object.entries(googleCommandContract)) {
      const flags = new Set(upstream.commands[command]?.split(' '));
      assert.ok(upstream.commands[command] !== undefined, command);
      for (const flag of Object.keys(contract.flags))
        assert.ok(flags.has(flag), command + ' ' + flag);
    }
  });
  it('should reject identity overrides and unreviewed authentication, flags and aliases', () => {
    for (const argv of [
      ['auth', 'tokens', 'export', 'one@example.com'],
      ['login', 'one@example.com'],
      ['config', 'set', 'keyring_backend', 'auto'],
      ['mcp'],
      ['api', 'call', 'gmail', 'v1', 'gmail.users.messages.send'],
      ['mail', 'search', 'q'],
      ['gmail', 'send', '--account=other@example.com'],
      ['gmail', 'send', '-a', 'other@example.com'],
      ['gmail', 'search', '--home=/tmp'],
      ['gmail', 'search', '--no-input=false'],
      ['drive', 'upload', 'f', '--convert'],
      ['docs', 'write', 'doc', '--markdown'],
      ['slides', 'insert-text', 'id', 'shape', 'text', '--batch=x'],
    ])
      assert.throws(() => parseGoogleCommand({ argv }));
  });
  it('should retain text as data when rebuilding argv and admit normal writes', () => {
    assert.deepEqual(
      parseGoogleCommand({
        argv: [
          'gmail',
          'send',
          '--subject',
          '--account=someone',
          '--body',
          'text',
          '--to',
          'one@example.com',
        ],
      }).argv,
      ['gmail', 'send', '--subject=--account=someone', '--body=text', '--to=one@example.com'],
    );
    for (const argv of [
      ['calendar', 'create', 'primary', '--summary', 'meeting'],
      ['contacts', 'create', '--given', 'Ada'],
      ['tasks', 'add', 'list', '--title', 'task'],
      ['docs', 'write', 'doc', '--text', 'hello'],
      ['sheets', 'update', 'sheet', 'A1', '--values-json', '[["x"]]'],
      ['slides', 'insert-text', 'slides', 'shape', 'hello'],
    ])
      assert.doesNotThrow(() => parseGoogleCommand({ argv }));
    assert.throws(() =>
      parseGoogleCommand({
        argv: ['sheets', 'update', 'sheet', 'A1', '--values-json', '@/etc/passwd'],
      }),
    );
  });
  it('should keep upload, attachment, body and output paths within canonical workspace roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'google-files-'));
    try {
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      await writeFile(join(workspace, 'body'), 'content');
      await writeFile(join(root, 'outside'), 'outside');
      await symlink(join(root, 'outside'), join(workspace, 'link'));
      await symlink(root, join(workspace, 'alias'));
      for (const argv of [
        ['drive', 'upload', 'body'],
        ['gmail', 'send', '--attach=body', '--body-file=body'],
        ['drive', 'download', 'id', '--out=new'],
        ['gmail', 'attachment', 'id', 'attachment', '--output=new'],
      ])
        await validateGoogleFiles({ argv }, workspace, [workspace]);
      await validateGoogleFiles({ argv: ['drive', 'upload', '../outside'] }, workspace, [
        workspace,
        root,
        join(root, 'missing-worktree'),
      ]);
      for (const argv of [
        ['drive', 'upload', '../outside'],
        ['drive', 'upload', 'link'],
        ['drive', 'download', 'id', '--out=alias/new'],
        ['gmail', 'send', '--signature-file=../outside'],
        ['contacts', 'update', 'id', '--from-file=../outside'],
        ['drive', 'download', 'id', '--out=.'],
        ['drive', 'download', 'id', '--out=link'],
      ])
        await assert.rejects(validateGoogleFiles({ argv }, workspace, [workspace]));
      assert.throws(() => parseGoogleCommand({ argv: ['drive', 'download', 'id'] }));
      assert.throws(() =>
        parseGoogleCommand({
          argv: ['gmail', 'attachment', 'id', 'attachment', '--out=new', '--name=../escape'],
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
