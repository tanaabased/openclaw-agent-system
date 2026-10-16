import assert from 'node:assert/strict';

import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import { BackupCleanupError, type BackupCleanupResult } from '../agent/backup-cleanup.ts';
import backupCleanup from '../cli/backup-cleanup.ts';
import { createCliStyles } from '../cli/output.ts';
import type { AgentCommandBinding } from '../agent/command-authority.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

const result: BackupCleanupResult = {
  agentId: 'tanaabot',
  workspaceDir: '/Workspace/Mixed',
  output: '/Archives/Backup',
  wouldDelete: ['/Archives/Backup/.pending-Fixture.tar.gz'],
  deleted: [],
  preserved: [
    { path: '/Archives/Backup/Complete.tar.gz', reason: 'complete-or-uncertain-archive' },
  ],
};
const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
  status: 'loaded',
  scope: { workspaceDir: result.workspaceDir },
  path: '/Workspace/Mixed/agent.yaml',
  digest: 'fixture',
  manifest: { schemaVersion: 1, agent: { id: 'tanaabot' }, backup: { output: result.output } },
  diagnostics: [],
  validationChecks: [],
};
async function capture(
  options: {
    json?: boolean;
    apply?: boolean;
    fail?: boolean;
    columns?: number;
    environment?: NodeJS.ProcessEnv;
    binding?: AgentCommandBinding;
    agentId?: string;
    foreign?: boolean;
  } = {},
) {
  const events: { stream: 'stdout' | 'stderr'; text: string }[] = [];
  let exitCode = 0;
  let calls = 0;
  await backupCleanup({
    ...options,
    json: options.json ?? false,
    apply: options.apply ?? false,
    environment: options.environment ?? {},
    workspaceDir: result.workspaceDir,
    commandAuthority: { resolve: async () => options.binding },
    manifestService: {
      loadForAgentId: async () => loaded,
      loadForCommandDirectory: async (path) =>
        path === result.output && options.foreign
          ? { ...loaded, manifest: { ...loaded.manifest, agent: { id: 'other' } } }
          : loaded,
    },
    service: {
      cleanup: async () => {
        calls++;
        if (options.fail)
          throw new BackupCleanupError('backup-cleanup-race', 'fixture changed', {
            ...result,
            deleted: ['/Already-Removed'],
            wouldDelete: ['/Remaining'],
          });
        return result;
      },
    },
    output: {
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
    },
    styles: createCliStyles(options.environment ?? { NO_COLOR: '1' }),
    terminalColumns: options.columns ?? 100,
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  return {
    events,
    exitCode,
    calls,
    stdout: events
      .filter(({ stream }) => stream === 'stdout')
      .map(({ text }) => text)
      .join(''),
  };
}

describe('cli/backup-cleanup', () => {
  it('should render shared styles and preserve literal targets at narrow widths', async () => {
    const plain = await capture();
    const colored = await capture({ environment: { FORCE_COLOR: '3' } });
    assert.deepEqual(
      colored.events.map(({ stream, text }) => ({ stream, text: ansis.strip(text) })),
      plain.events,
    );
    assert.ok(colored.stdout.includes('\u001b[38;2;0;200;138m'));
    assert.match(plain.stdout, /mode +preview/u);
    assert.ok(plain.stdout.includes('/Archives/Backup/Complete.tar.gz'));
    for (const columns of [12, 40]) {
      const narrow = await capture({ columns });
      assert.ok(
        narrow.stdout
          .split('\n')
          .slice(0, -3)
          .every((line) => stringWidth(line) <= columns),
      );
      assert.ok(
        narrow.stdout.replace(/\s/gu, '').includes('/Archives/Backup/.pending-Fixture.tar.gz'),
      );
    }
    assert.ok(
      (await capture({ environment: { NO_COLOR: '', FORCE_COLOR: '3' } })).events.every(
        ({ text }) => !text.includes('\u001b'),
      ),
    );
  });

  it('should emit pure json with unchanged status and exact partial failure actions', async () => {
    for (const apply of [false, true]) {
      const captured = await capture({ json: true, apply, environment: { FORCE_COLOR: '3' } });
      assert.deepEqual(JSON.parse(captured.stdout), {
        status: apply ? 'applied' : 'preview',
        ...result,
      });
      assert.equal(captured.exitCode, 0);
    }
    for (const json of [false, true]) {
      const failed = await capture({ json, apply: true, fail: true });
      assert.equal(failed.exitCode, 1);
      assert.equal(failed.events.at(-1)?.stream, 'stderr');
      assert.ok(failed.events.slice(0, -1).every(({ stream }) => stream === 'stdout'));
      if (json) {
        const parsed = JSON.parse(failed.stdout);
        assert.equal(parsed.status, 'failed');
        assert.deepEqual(parsed.deleted, ['/Already-Removed']);
        assert.deepEqual(parsed.wouldDelete, ['/Remaining']);
        assert.equal(parsed.diagnostics[0].code, 'backup-cleanup-race');
        assert.ok(failed.events.every(({ text }) => !text.includes('\u001b')));
      } else assert.equal(failed.events.at(-1)!.text.match(/messages/gu)?.length, 1);
    }
  });

  it('should admit only bound preview and reject cross-agent destinations before service work', async () => {
    const binding = {
      agentId: 'tanaabot',
      admittedWorkingDirectories: ['/Workspace/Mixed'],
      workingDirectory: '/Workspace/Mixed',
    };
    assert.equal((await capture({ binding })).calls, 1);
    for (const options of [
      { binding, apply: true },
      { binding, agentId: 'other' },
      { foreign: true },
      { environment: { AGENT_SYSTEM_EXEC_CAPABILITY: 'unresolved' } },
    ]) {
      const denied = await capture({ ...options, json: true });
      assert.equal(denied.exitCode, 1);
      assert.equal(denied.calls, 0);
      assert.equal(JSON.parse(denied.stdout).status, 'failed');
    }
  });
});
