import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import AgentDoctorService from '../agent/doctor-service.ts';
import defineAgentSystemCliTool from '../api/define-cli-tool.ts';
import {
  requiredToolExecutables,
  unavailableToolExecutables,
} from '../api/executable-requirements.ts';
import AgentSystemToolRegistry from '../api/registry.ts';
import { createToolTestDefinition } from './tool-test-fixture.ts';

describe('api/executable-requirements', () => {
  it('should include the cli primary and deduplicate conditional requirements', () => {
    assert.deepEqual(
      requiredToolExecutables(
        {
          runner: { executable: 'git' },
          requiredExecutables: (signing: boolean) =>
            signing ? ['git', 'ssh-agent', 'ssh-agent', 'ssh-keygen'] : [],
        },
        true,
      ),
      ['git', 'ssh-agent', 'ssh-keygen'],
    );
    assert.deepEqual(requiredToolExecutables({ requiredExecutables: () => [] }, false), []);
    assert.deepEqual(
      requiredToolExecutables(
        { requiredExecutables: (enabled: boolean) => (enabled ? ['git'] : []) },
        false,
      ),
      [],
    );
  });

  it('should use the trusted resolver exclusions without launching commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-system-executable-'));
    try {
      const host = join(root, 'host');
      const excluded = join(root, 'excluded');
      await mkdir(host);
      await mkdir(excluded);
      const hostTool = join(host, 'host-tool');
      const hiddenTool = join(excluded, 'hidden-tool');
      await writeFile(hostTool, 'host');
      await writeFile(hiddenTool, 'hidden');
      await chmod(hostTool, 0o755);
      await chmod(hiddenTool, 0o755);
      await symlink(hiddenTool, join(host, 'hidden-tool'));
      assert.deepEqual(
        await unavailableToolExecutables(
          ['host-tool', 'hidden-tool', 'hidden-tool', 'absent'],
          `${host}:${excluded}`,
          [excluded],
        ),
        ['hidden-tool', 'absent'],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('should give one finding per affected configured tool and inspect the others', async () => {
    const first = createToolTestDefinition();
    first.requiredExecutables = () => ['helper', 'test-tool', 'second-helper'];
    const skipped = createToolTestDefinition({ configured: false });
    skipped.id = 'skipped-tool';
    skipped.commands = [];
    const healthy = createToolTestDefinition();
    healthy.id = 'healthy-tool';
    healthy.commands = [];
    healthy.runner.executable = 'healthy';
    const checked: string[] = [];
    const service = new AgentDoctorService({
      lifecycleRegistry: {
        async inspect() {
          return [];
        },
      },
      toolRegistry: new AgentSystemToolRegistry([
        defineAgentSystemCliTool(first),
        defineAgentSystemCliTool(skipped),
        defineAgentSystemCliTool(healthy),
      ]),
      baseEnvironment: { PATH: '/host/bin' },
      excludedExecutableDirectories: ['/managed/bin'],
      async resolveExecutable(name, path, excluded) {
        checked.push(name);
        assert.equal(path, '/host/bin');
        assert.ok(excluded?.includes('/workspace/bin'));
        assert.ok(excluded?.includes('/managed/bin'));
        if (name === 'helper' || name === 'second-helper') throw new Error('missing');
        return `/host/bin/${name}`;
      },
    });
    const manifest = { schemaVersion: 1 as const, agent: { id: 'data' } };
    const result = await service.inspect({
      runtime: 'openclaw',
      manifest,
      workspaceDir: '/workspace',
    });

    assert.equal(result.status, 'blocked');
    assert.deepEqual(checked, ['test-tool', 'helper', 'second-helper', 'healthy']);
    assert.deepEqual(
      result.findings.map(({ component, code }) => ({ component, code })),
      [{ component: 'test-tool', code: 'tool-executables-unavailable' }],
    );
    assert.match(result.findings[0]?.message ?? '', /helper, second-helper/u);
    assert.match(result.findings[0]?.remediation ?? '', /host.*runtime PATH/u);
    assert.deepEqual(
      (await service.inspect({ runtime: 'codex', manifest, workspaceDir: '/workspace' })).findings,
      [],
    );
  });
});
