import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSystemCliRunRequest } from '../api/types.ts';
import type { AgentManifest } from '../manifest/types.ts';
import createGoogleCapability from '../tools/google/capability.ts';
import { fakeGoogle, googleConfiguration, googleValues } from './google-test-fixture.ts';

describe('google lifecycle', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'google-lifecycle-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function fixture(excluded = false) {
    const workspaceDir = join(root, 'workspace');
    const hostBin = join(root, 'host');
    await mkdir(workspaceDir);
    await mkdir(hostBin);
    await writeFile(join(hostBin, 'gog'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const manifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'one' },
      google: googleConfiguration,
    };
    const values: Record<string, string> = { ...googleValues };
    let resolutions = 0;
    const requests: AgentSystemCliRunRequest[] = [];
    const capability = createGoogleCapability({
      baseEnvironment: { PATH: hostBin },
      excludedExecutableDirectories: excluded ? [hostBin] : [],
      privateStateRoot: join(root, 'private'),
      runCli: fakeGoogle(requests),
      environmentService: {
        async loadForWorkspace() {
          resolutions++;
          return {
            status: 'loaded' as const,
            scope: { agentId: 'one', workspaceDir },
            path: join(workspaceDir, 'agent.yaml'),
            digest: 'digest',
            manifest,
            diagnostics: [],
            validationChecks: [],
            environment: { values, variables: [] },
          };
        },
      },
    });
    return {
      contribution: capability.lifecycleContributions[0]!,
      context: { workspaceDir, manifest },
      requests,
      values,
      resolutions: () => resolutions,
    };
  }
  it('should validate passively and inspect live identity without repairing credentials', async () => {
    const f = await fixture();
    f.contribution.validate!(f.context);
    assert.equal(f.resolutions(), 0);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.contribution.inspect!(f.context))[0]?.status, 'drift');
    assert.equal(f.requests.length, 0);
    assert.equal((await f.contribution.reconcile!(f.context)).outcomes[0]?.status, 'created');
    const receiptPath = join(root, 'private', 'one', 'tools', 'gog', 'current.json');
    const before = await readFile(receiptPath, 'utf8');
    f.requests.length = 0;
    const findings = await f.contribution.inspect!(f.context);
    assert.equal(findings[0]?.code, 'google-live-identity-ready');
    assert.ok(f.requests.some((request) => request.argv.includes('oauth2.userinfo.get')));
    assert.ok(!f.requests.some((request) => request.argv.includes('auth')));
    assert.equal(await readFile(receiptPath, 'utf8'), before);
  });
  it('should report a missing account passively and resolve an inherited email and declared home', async () => {
    const f = await fixture();
    f.context.manifest.google = { ...googleConfiguration, account: undefined };
    assert.equal(
      f.contribution.validate!(f.context)?.diagnostics?.[0]?.code,
      'google-account-required',
    );
    assert.equal(f.resolutions(), 0);
    f.context.manifest.agent.email = 'one@example.com';
    const home = join(root, 'declared-gog');
    f.values.GOG_HOME = home;
    assert.equal((await f.contribution.reconcile!(f.context)).outcomes[0]?.status, 'created');
    assert.equal(JSON.parse(await readFile(join(home, 'current.json'), 'utf8')).agentId, 'one');
    assert.equal((await f.contribution.inspect!(f.context))[0]?.code, 'google-live-identity-ready');
  });
  it('should reject excluded executables before resolving secrets or importing state', async () => {
    const f = await fixture(true);
    assert.equal((await f.contribution.inspect!(f.context))[0]?.code, 'google-tool_unavailable');
    await assert.rejects(f.contribution.reconcile!(f.context), { code: 'google-tool_unavailable' });
    assert.equal(f.resolutions(), 0);
    assert.equal(f.requests.length, 0);
  });
});
