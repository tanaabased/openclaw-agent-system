import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import assessmentGuidance from '../agent/assessment-guidance.ts';

describe('agent/assessment-guidance', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'assessment-guidance-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should preserve single and multiline guidance with reproducible content digests', async () => {
    assert.equal(await assessmentGuidance(root, undefined), undefined);
    for (const content of ['Prefer small changes.', 'First investigate.\nThen propose.\n']) {
      await writeFile(join(root, 'guidance.md'), content);
      const inline = await assessmentGuidance(root, content);
      const file = await assessmentGuidance(root, { file: 'guidance.md' });
      assert.equal(inline!.content, content);
      assert.equal(file!.content, content);
      assert.equal(inline!.digest, file!.digest);
      assert.equal(file!.path, join(root, 'guidance.md'));
      assert.equal(file!.source, 'file');
    }
  });

  it('should reject paths and symlinks outside the trusted file contract', async () => {
    for (const file of [
      '/absolute',
      '../outside',
      'a/../file',
      'https://example.test/file',
      'C:\\file',
      'file\0',
      './file',
    ])
      await assert.rejects(assessmentGuidance(root, { file }), /guidance-path-invalid/);
    await writeFile(join(root, 'real.md'), 'guidance');
    await symlink(join(root, 'real.md'), join(root, 'link.md'));
    await mkdir(join(root, 'directory'));
    await symlink(join(root, 'directory'), join(root, 'linked-directory'));
    for (const file of ['link.md', 'linked-directory/real.md'])
      await assert.rejects(assessmentGuidance(root, { file }), /guidance-symlink/);
    await assert.rejects(assessmentGuidance(root, { file: 'directory' }), /guidance-not-regular/);
    await assert.rejects(assessmentGuidance(root, { file: 'missing' }), /guidance-unreadable/);
  });

  it('should bound bytes and reject malformed or empty text without leaking contents', async () => {
    for (const content of ['', ' \n', 'secret\0text'])
      await assert.rejects(
        assessmentGuidance(root, content),
        /^Error: dispatch-assessment-guidance-content-invalid$/,
      );
    await assert.rejects(assessmentGuidance(root, 'é'.repeat(16385)), /guidance-too-large/);
    assert.equal((await assessmentGuidance(root, 'a'.repeat(32768)))!.content.length, 32768);
    for (const [content, code] of [
      [Buffer.from([0xff]), 'encoding'],
      [Buffer.alloc(32769, 65), 'too-large'],
    ] as const) {
      await writeFile(join(root, 'bad.md'), content);
      await assert.rejects(
        assessmentGuidance(root, { file: 'bad.md' }),
        new RegExp('guidance-' + code),
      );
    }
  });
});
