import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import resolveCodexCommandAgentId from '../agent/resolve-codex-command-id.ts';

describe('agent/resolve-codex-command-id', () => {
  let root: string;
  let codexHome: string;
  let stateDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-system-codex-agent-'));
    codexHome = join(root, 'agents', 'data', 'codex-home');
    stateDir = join(root, 'state');
    await Promise.all([codexHome, stateDir].map((path) => mkdir(path, { recursive: true })));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('should match a canonical codex home to a normalized configured agent id', async () => {
    const agentId = await resolveCodexCommandAgentId({
      agentIds: [' missing ', ' DATA '],
      codexHome,
      openClawStateDir: stateDir,
      resolveAgentDir: (id) => join(root, 'agents', id),
      resolveStateDir: () => stateDir,
    });

    assert.equal(agentId, 'data');
  });

  it('should reject a codex home from another openclaw state profile', async () => {
    const otherStateDir = join(root, 'other-state');
    await mkdir(otherStateDir);

    const agentId = await resolveCodexCommandAgentId({
      agentIds: ['data'],
      codexHome,
      openClawStateDir: otherStateDir,
      resolveAgentDir: (id) => join(root, 'agents', id),
      resolveStateDir: () => stateDir,
    });

    assert.equal(agentId, undefined);
  });

  it('should leave missing and unmatched codex homes unresolved', async () => {
    const options = {
      agentIds: ['data'],
      resolveAgentDir: (id: string) => join(root, 'agents', id),
      resolveStateDir: () => stateDir,
    };

    assert.equal(
      await resolveCodexCommandAgentId({
        ...options,
        codexHome: join(root, 'missing-codex-home'),
      }),
      undefined,
    );

    const unmatchedHome = join(root, 'agents', 'other', 'codex-home');
    await mkdir(unmatchedHome, { recursive: true });
    assert.equal(
      await resolveCodexCommandAgentId({ ...options, codexHome: unmatchedHome }),
      undefined,
    );
  });
});
