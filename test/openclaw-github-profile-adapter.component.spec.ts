import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import OpenClawGitHubProfileAdapter, {
  OpenClawGitHubProfileError,
} from '../tools/github/openclaw-profile-adapter.ts';

describe('tools/github/openclaw-profile-adapter', () => {
  it('should conceal credential values when profile materialization fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-openclaw-profile-adapter-'));
    const directory = join(root, 'profile');
    await mkdir(directory);
    await writeFile(join(directory, 'hosts.yml'), 'existing: true\n');
    const adapter = new OpenClawGitHubProfileAdapter();

    try {
      await assert.rejects(
        adapter.materialize({
          credential: { host: 'github.com', token: 'private-token' },
          directory,
          identity: { login: 'emoriwan', nodeId: 'U_emori' },
        }),
        (error: unknown) =>
          error instanceof OpenClawGitHubProfileError &&
          error.code === 'openclaw-github-profile-materialization-failed' &&
          !error.message.includes('private-token'),
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
