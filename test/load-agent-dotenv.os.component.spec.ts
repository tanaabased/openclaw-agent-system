import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import loadAgentDotenv, { maximumDotenvBytes } from '../environment/load-dotenv.ts';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-system-dotenv-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('environment/load-dotenv', () => {
  it('should load ordered workspace files into source-labelled layers', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'env'));
    await Promise.all([
      writeFile(join(root, 'env', 'base.env'), 'LAYERED=base\nBASE_ONLY=one\n'),
      writeFile(join(root, 'env', 'local.env'), 'LAYERED=local\n'),
    ]);

    assert.deepEqual(await loadAgentDotenv(root, ['env/base.env', 'env/local.env']), {
      status: 'loaded',
      sources: [
        {
          source: 'environment.dotenv[0]',
          values: { LAYERED: 'base', BASE_ONLY: 'one' },
        },
        {
          source: 'environment.dotenv[1]',
          values: { LAYERED: 'local' },
        },
      ],
    });
  });

  it('should reject missing, absolute, escaping, duplicate, oversized, and invalid files', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await Promise.all([
      writeFile(join(root, 'valid.env'), 'VALID=one\n'),
      writeFile(join(root, 'large.env'), Buffer.alloc(maximumDotenvBytes + 1)),
      writeFile(join(root, 'invalid.env'), Buffer.from([0xc3, 0x28])),
      writeFile(join(outside, 'outside.env'), 'OUTSIDE=private-value\n'),
    ]);
    await symlink(join(outside, 'outside.env'), join(root, 'outside-link.env'));

    const result = await loadAgentDotenv(root, [
      'missing.env',
      join(root, 'valid.env'),
      '../outside.env',
      'outside-link.env',
      'valid.env',
      './valid.env',
      'large.env',
      'invalid.env',
    ]);

    assert.equal(result.status, 'invalid');
    if (result.status !== 'invalid') return;
    assert.deepEqual(
      new Set(result.diagnostics.map(({ code }) => code)),
      new Set([
        'dotenv-file-missing',
        'dotenv-path-absolute',
        'dotenv-path-outside-workspace',
        'dotenv-path-duplicate',
        'dotenv-file-too-large',
        'dotenv-encoding',
      ]),
    );
    assert.equal(
      result.diagnostics.some(({ message }) => message.includes('private-value')),
      false,
    );
  });

  it('should report parser diagnostics without including dotenv values', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'broken.env'), 'PRIVATE_NAME=private-value\nPRIVATE_NAME=again\n');

    const result = await loadAgentDotenv(root, ['broken.env']);

    assert.equal(result.status, 'invalid');
    if (result.status !== 'invalid') return;
    assert.equal(result.diagnostics[0]?.code, 'dotenv-duplicate-variable');
    assert.equal(result.diagnostics[0]?.message.includes('private-value'), false);
  });
});
