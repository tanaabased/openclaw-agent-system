import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack } from 'tar-stream';
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import WorkspaceBackupService from '../agent/backup-service.ts';
import { BackupError, type LegacyWorkspaceBackupManifest } from '../agent/backup-types.ts';
import { planWorkspaceBackup } from '../agent/backup-selection.ts';
import { verifyWorkspaceArchive, writeWorkspaceArchive } from '../agent/backup-archive.ts';
import type { AgentManifest } from '../manifest/types.ts';
import parseAgentManifest from '../manifest/parse.ts';
import backupCreate from '../cli/backup-create.ts';
import backupVerify from '../cli/backup-verify.ts';
import backupRestore from '../cli/backup-restore.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';
import { createCliStyles } from '../cli/output.ts';

const executeFile = promisify(execFile);
const manifest: AgentManifest = {
  schemaVersion: 1,
  agent: { id: 'tanaabot' },
  backup: { openclawState: 'off' },
};

describe('workspace backup', () => {
  let root: string;
  let workspace: string;
  const service = new WorkspaceBackupService();
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-backup-')));
    workspace = join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(join(workspace, 'agent.yaml'), 'schema-version: 1\nagent: { id: tanaabot }\n');
    await writeFile(join(workspace, 'MEMORY.md'), 'private memory\n');
    await mkdir(join(workspace, 'memory'));
    await writeFile(join(workspace, 'memory', 'daily.md'), 'daily memory\n');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('should preview verification and coverage separately for backup fixtures', async () => {
    const previews: string[] = [];
    for (const state of ['captured', 'off', 'absent'] as const) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const archive = join(root, `${state}.tar.gz`);
      const fixture = {
        format: 'agent-system-backup' as const,
        version: 2 as const,
        agentId: 'tanaabot',
        capturedAt: '2026-10-07T00:00:00.000Z',
        settings: {
          output: '/workspace/backups',
          include: [],
          exclude: [],
          openclawState: 'auto' as const,
          gitIgnore: true,
        },
        inventory: [
          { path: 'MEMORY.md', type: 'file' as const, mode: 0o600, size: 14, sha256: 'fixture' },
        ],
        diagnostics: [],
        coverage: {
          stage: 'workspace-only' as const,
          openclawState: state,
          atomic: false as const,
          omittedPaths: [],
          limitations: [],
        },
      };
      await backupVerify({
        service: { verify: async () => fixture } as unknown as WorkspaceBackupService,
        agentId: 'tanaabot',
        workspaceDir: '/workspace',
        environment: {},
        json: false,
        archive,
        output: {
          writeStdout: (value) => stdout.push(value),
          writeStderr: (value) => stderr.push(value),
        },
        styles: createCliStyles({ NO_COLOR: '1' }),
        setExitCode() {},
      });
      const preview = `${stdout.join('')}\n${stderr.join('')}`;
      assert.match(preview, /verification  verified/u);
      assert.match(preview, new RegExp(`coverage\\s+workspace and agent state: ${state}`, 'u'));
      assert.ok(preview.includes(archive));
      if (state === 'captured') assert.match(preview, /coverage  workspace and agent state: captured/u);
      else assert.doesNotMatch(stderr.join(''), /warning/u);
      previews.push(preview);
    }

    const failedOut: string[] = [];
    const failedErr: string[] = [];
    const failedExit: number[] = [];
    await backupVerify({
      service: {
        verify: async () => {
          throw new BackupError('backup-checksum-mismatch', 'checksum mismatch');
        },
      } as unknown as WorkspaceBackupService,
      agentId: 'tanaabot',
      workspaceDir: '/workspace',
      environment: {},
      json: false,
      archive: join(root, 'failed.tar.gz'),
      output: {
        writeStdout: (value) => failedOut.push(value),
        writeStderr: (value) => failedErr.push(value),
      },
      styles: createCliStyles({ NO_COLOR: '1' }),
      setExitCode: (code) => failedExit.push(code),
    });
    assert.match(failedOut.join(''), /verification  failed \\(backup-checksum-mismatch\\)/u);
    assert.deepEqual(failedExit, [1]);
    assert.match(failedErr.join(''), /error/u);
    assert.equal(previews.length, 3);
  });

  it('should strictly decode backup keys without changing literal patterns', () => {
    const parsed = parseAgentManifest(
      'schema-version: 1\nagent: { id: tanaabot }\nbackup:\n  git-ignore: true\n  include: [MEMORY.md, memory/**]\n  exclude: []\n',
    );
    assert.equal(parsed.status, 'valid');
    if (parsed.status === 'valid')
      assert.deepEqual(parsed.manifest.backup, {
        gitIgnore: true,
        include: ['MEMORY.md', 'memory/**'],
        exclude: [],
      });
    assert.equal(
      parseAgentManifest('schema-version: 1\nagent: { id: tanaabot }\nbackup: { retention: 3 }\n')
        .status,
      'invalid',
    );
  });

  it('should distinguish absent, required, and explicitly omitted agent databases', async function () {
    this.timeout(10_000);
    const agentDir = join(root, 'custom-agent');
    const selected = new WorkspaceBackupService(async () => ({ paths: [agentDir], agentDir }));
    const auto = await selected.create(
      await selected.plan({
        manifest: { ...manifest, backup: { openclawState: 'auto' } },
        workspaceDir: workspace,
      }),
    );
    assert.equal(auto.manifest.coverage.openclawState, 'absent');
    assert.equal(auto.manifest.snapshot, undefined);
    await assert.rejects(
      selected.create(
        await selected.plan({
          manifest: { ...manifest, backup: { openclawState: 'required' } },
          workspaceDir: workspace,
        }),
      ),
      { code: 'backup-snapshot-absent' },
    );
    const off = await selected.create(await selected.plan({ manifest, workspaceDir: workspace }));
    assert.equal(off.manifest.coverage.openclawState, 'off');
    assert.equal(off.manifest.snapshot, undefined);
  });

  it('should keep memory sources independent of search provider selection', async () => {
    for (const provider of ['openai', 'local', 'none'] as const) {
      const selected = await service.plan({
        manifest: { ...manifest, memory: { search: { provider } } },
        workspaceDir: workspace,
      });
      assert.ok(selected.files.includes('MEMORY.md'));
      assert.ok(selected.files.includes('memory/daily.md'));
      assert.equal(selected.settings.openclawState, 'off');
    }
  });

  it('should package and verify only the selected custom agent snapshot', async () => {
    const agentDir = join(workspace, 'custom-agent');
    await mkdir(agentDir);
    const database = join(agentDir, 'openclaw-agent.sqlite');
    await writeFile(database, 'durable-agent-record');
    await writeFile(`${database}-wal`, 'live-sidecar');
    const calls: string[] = [];
    const snapshotCommand = async (args: string[]) => {
      calls.push(args[2]!);
      if (args[2] === 'create') {
        const repository = args[args.indexOf('--repository') + 1]!;
        const snapshot = join(repository, '2026-09-28-00-00-00-000Z-fixture');
        await mkdir(snapshot, { recursive: true, mode: 0o700 });
        await copyFile(database, join(snapshot, 'database.sqlite'));
        const bytes = await readFile(join(snapshot, 'database.sqlite'));
        const upstream = {
          schemaVersion: 1,
          snapshotId: '2026-09-28-00-00-00-000Z-fixture',
          createdAt: '2026-09-28T00:00:00.000Z',
          database: {
            role: 'agent',
            agentId: 'tanaabot',
            basename: 'openclaw-agent.sqlite',
            userVersion: 1,
          },
          artifact: {
            path: 'database.sqlite',
            sha256: createHash('sha256').update(bytes).digest('hex'),
            sizeBytes: bytes.length,
          },
        };
        await writeFile(join(snapshot, 'manifest.json'), JSON.stringify(upstream));
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, snapshotPath: snapshot, manifest: upstream }),
          stderr: '',
        };
      }
      if (args[2] === 'restore') {
        const snapshot = args[3]!;
        const target = args[args.indexOf('--target') + 1]!;
        await copyFile(join(snapshot, 'database.sqlite'), target);
        return {
          code: 0,
          stdout: JSON.stringify({
            ok: true,
            snapshotPath: snapshot,
            targetPath: target,
            manifest: JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8')),
          }),
          stderr: '',
        };
      }
      const snapshot = args[3]!;
      const upstream = JSON.parse(await readFile(join(snapshot, 'manifest.json'), 'utf8'));
      const bytes = await readFile(join(snapshot, 'database.sqlite'));
      if (createHash('sha256').update(bytes).digest('hex') !== upstream.artifact.sha256)
        return { code: 1, stdout: '', stderr: 'snapshot checksum mismatch' };
      return {
        code: 0,
        stdout: JSON.stringify({ ok: true, snapshotPath: snapshot, manifest: upstream }),
        stderr: '',
      };
    };
    const selected = new WorkspaceBackupService(
      async () => ({ paths: [agentDir], agentDir, openclawVersion: '2026.9.6' }),
      snapshotCommand,
    );
    const result = await selected.create(
      await selected.plan({
        manifest: { ...manifest, backup: { openclawState: 'required' } },
        workspaceDir: workspace,
        overrides: { include: ['**'] },
      }),
    );
    assert.equal(result.manifest.coverage.openclawState, 'captured');
    assert.equal(result.manifest.snapshot?.manifest.database.agentId, 'tanaabot');
    assert.equal(result.manifest.snapshot?.openclawVersion, '2026.9.6');
    assert.ok(!result.manifest.inventory.some(({ path }) => path.startsWith('custom-agent')));
    assert.ok(calls.includes('create'));
    assert.ok(calls.includes('verify'));
    const restored = join(root, 'snapshot-restored');
    await mkdir(restored);
    await executeFile('/usr/bin/tar', ['-xzf', result.archive, '-C', restored]);
    assert.equal(
      await readFile(join(restored, 'openclaw-state', 'database.sqlite'), 'utf8'),
      'durable-agent-record',
    );
    assert.deepEqual((await readdir(join(restored, 'openclaw-state'))).sort(), [
      'database.sqlite',
      'manifest.json',
    ]);
    assert.deepEqual(await selected.verify(result.archive), result.manifest);
    const recovery = await selected.restore(result.archive, join(root, 'agent-recovered'));
    assert.equal(recovery.manifest.agentId, 'tanaabot');
    assert.equal(
      await readFile(join(recovery.target, 'openclaw-state', 'openclaw-agent.sqlite'), 'utf8'),
      'durable-agent-record',
    );
    assert.equal(
      await readFile(join(recovery.target, 'workspace', 'MEMORY.md'), 'utf8'),
      'private memory\n',
    );
    assert.ok(calls.includes('restore'));
    const failing = new WorkspaceBackupService(
      async () => ({ paths: [agentDir], agentDir }),
      async (args) =>
        args[2] === 'restore'
          ? { code: 1, stdout: '', stderr: 'restore refused' }
          : snapshotCommand(args),
    );
    const empty = join(root, 'empty-recovery');
    await mkdir(empty, { mode: 0o700 });
    await assert.rejects(failing.restore(result.archive, empty), {
      code: 'backup-snapshot-restore-failed',
    });
    assert.deepEqual(await readdir(empty), []);
    assert.equal(await readFile(result.archive).then((bytes) => bytes.length > 0), true);
  });

  it('should restore workspace files and safe links into an empty target', async () => {
    await writeFile(join(workspace, 'run.sh'), '#!/bin/sh\nexit 0\n');
    await chmod(join(workspace, 'run.sh'), 0o755);
    await symlink('MEMORY.md', join(workspace, 'memory-link'));
    const created = await service.create(await service.plan({ manifest, workspaceDir: workspace }));
    const target = join(root, 'recovered');
    await mkdir(target, { mode: 0o700 });
    const recovered = await service.restore(created.archive, target, 'tanaabot');
    assert.equal(recovered.database, undefined);
    assert.equal(
      await readFile(join(target, 'workspace', 'memory-link'), 'utf8'),
      'private memory\n',
    );
    assert.equal((await lstat(join(target, 'workspace', 'run.sh'))).mode & 0o777, 0o755);
    assert.equal(
      JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')).agentId,
      'tanaabot',
    );
    assert.equal(await readFile(join(workspace, 'MEMORY.md'), 'utf8'), 'private memory\n');
  });

  it('should reject live and nonempty targets without changing them', async () => {
    const created = await service.create(await service.plan({ manifest, workspaceDir: workspace }));
    const selected = new WorkspaceBackupService(async () => ({
      paths: [],
      livePaths: [workspace, join(root, 'live-state')],
    }));
    await assert.rejects(selected.restore(created.archive, join(workspace, 'recovery')), {
      code: 'backup-target-live',
    });
    await assert.rejects(lstat(join(workspace, 'recovery')), { code: 'ENOENT' });
    const alias = join(root, 'live-alias');
    await symlink(workspace, alias);
    await assert.rejects(selected.restore(created.archive, alias), {
      code: 'backup-target-unsafe',
    });
    const nonempty = join(root, 'nonempty');
    await mkdir(nonempty, { mode: 0o700 });
    await writeFile(join(nonempty, 'keep.txt'), 'keep');
    await assert.rejects(selected.restore(created.archive, nonempty), {
      code: 'backup-target-nonempty',
    });
    assert.equal(await readFile(join(nonempty, 'keep.txt'), 'utf8'), 'keep');
  });

  it('should fail an existing database when upstream capture fails', async () => {
    const agentDir = join(root, 'agent');
    await mkdir(agentDir);
    await writeFile(join(agentDir, 'openclaw-agent.sqlite'), 'unreadable fixture');
    const selected = new WorkspaceBackupService(
      async () => ({ paths: [agentDir], agentDir }),
      async () => ({ code: 1, stdout: '', stderr: 'database integrity failed' }),
    );
    await assert.rejects(
      selected.create(
        await selected.plan({
          manifest: { ...manifest, backup: { openclawState: 'auto' } },
          workspaceDir: workspace,
        }),
      ),
      { code: 'backup-snapshot-failed' },
    );
    assert.deepEqual(await readdir(join(workspace, '.agent-system', 'backups')), []);
  });

  it('should continue verifying version one workspace archives', async () => {
    const current = await service.create(await service.plan({ manifest, workspaceDir: workspace }));
    const { output, gitIgnore, include, exclude } = current.manifest.settings;
    const legacy: LegacyWorkspaceBackupManifest = {
      format: 'agent-system-backup',
      version: 1,
      agentId: current.manifest.agentId,
      capturedAt: current.manifest.capturedAt,
      settings: { output, gitIgnore, include, exclude },
      coverage: {
        stage: 'workspace-only',
        openclawState: 'unsupported',
        atomic: false,
        omittedPaths: [],
        limitations: [],
      },
      inventory: current.manifest.inventory,
      diagnostics: current.manifest.diagnostics,
    };
    const archive = join(root, 'legacy.tar.gz');
    await writeWorkspaceArchive(archive, workspace, legacy);
    assert.deepEqual(await service.verify(archive), legacy);
    const recovery = await service.restore(archive, join(root, 'legacy-recovery'));
    assert.equal(recovery.manifest.version, 1);
    assert.equal(
      await readFile(join(recovery.target, 'workspace', 'MEMORY.md'), 'utf8'),
      'private memory\n',
    );
  });

  it('should recover ignored descendants and let excludes win', async () => {
    await executeFile('/usr/bin/git', ['init', workspace]);
    await writeFile(join(workspace, '.gitignore'), 'MEMORY.md\nmemory/\n');
    const selected = await service.plan({
      manifest: {
        ...manifest,
        backup: {
          gitIgnore: true,
          include: ['MEMORY.md', 'memory/**'],
          exclude: ['memory/daily.md'],
        },
      },
      workspaceDir: workspace,
    });
    assert.ok(selected.files.includes('MEMORY.md'));
    assert.ok(!selected.files.includes('memory/daily.md'));
    const recovered = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { gitIgnore: true, include: ['memory/**'] },
    });
    assert.ok(recovered.files.includes('memory/daily.md'));
    assert.ok(!recovered.files.includes('MEMORY.md'));
  });

  it('should prune large irrelevant trees and limit the final payload including parents', async function () {
    this.timeout(120_000);
    await executeFile('/usr/bin/git', ['init', workspace]);
    await writeFile(join(workspace, '.gitignore'), 'large/\n');
    await mkdir(join(workspace, 'large'));
    // keep each inode's link count bounded across supported filesystems.
    for (let batch = 0; batch < 100; batch++) {
      const source = join(workspace, 'large', `${batch}-0`);
      await writeFile(source, 'synthetic payload');
      await Promise.all(
        Array.from({ length: 999 }, (_, index) =>
          link(source, join(workspace, 'large', `${batch}-${index + 1}`)),
        ),
      );
    }
    assert.equal((await readdir(join(workspace, 'large'))).length, 100_000);
    const ignored = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { gitIgnore: true, include: ['{MEMORY,DREAMS,BOOTSTRAP}.md'] },
    });
    assert.ok(ignored.files.includes('MEMORY.md'));
    assert.ok(!ignored.files.some((path) => path.startsWith('large')));
    const excluded = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { include: ['large/**'], exclude: ['large/**'] },
    });
    assert.ok(excluded.files.length < 100);
    assert.ok(!excluded.files.some((path) => path.startsWith('large/')));
    await assert.rejects(
      service.plan({
        manifest,
        workspaceDir: workspace,
        overrides: {
          gitIgnore: true,
          include: ['large/*'],
          exclude: ['.git', '.gitignore', 'agent.yaml', 'MEMORY.md', 'memory'],
        },
      }),
      { code: 'backup-inventory-too-large' },
    );
  });

  it('should retain tracked and explicitly included descendants of ignored trees', async () => {
    await executeFile('/usr/bin/git', ['init', root]);
    await mkdir(join(workspace, '.private', 'nested'), { recursive: true });
    await writeFile(join(workspace, '.private', 'nested', 'tracked.md'), 'tracked');
    await writeFile(join(workspace, '.private', 'nested', 'included.md'), 'included');
    await writeFile(join(workspace, '.private', 'nested', 'other.md'), 'ignored');
    await writeFile(join(workspace, '.gitignore'), '.private/\nMEMORY.md\nmemory/\n');
    await executeFile('/usr/bin/git', [
      '-C',
      root,
      'add',
      '--force',
      '--',
      'workspace/.private/nested/tracked.md',
    ]);
    const result = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: {
        gitIgnore: true,
        include: ['{MEMORY,DREAMS,BOOTSTRAP}.md', 'memory/**', '.private/nested/included.md'],
      },
    });
    for (const path of [
      'MEMORY.md',
      'memory/daily.md',
      '.private',
      '.private/nested',
      '.private/nested/tracked.md',
      '.private/nested/included.md',
    ])
      assert.ok(result.files.includes(path), path);
    assert.ok(!result.files.includes('.private/nested/other.md'));
    assert.ok(!result.diagnostics.some(({ code }) => code === 'backup-include-unmatched'));
    const excluded = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: {
        gitIgnore: true,
        include: ['.private/nested/included.md', '.private/nested/*.md'],
        exclude: ['.private'],
      },
    });
    assert.ok(!excluded.files.some((path) => path.startsWith('.private')));
    assert.ok(!excluded.diagnostics.some(({ code }) => code === 'backup-include-unmatched'));
    await assert.rejects(
      service.plan({
        manifest,
        workspaceDir: workspace,
        overrides: { include: ['.private/missing.md'], exclude: ['.private'] },
      }),
      { code: 'backup-required-file-missing' },
    );
  });

  it('should keep root-only brace matching and recover recursive dependency memory', async () => {
    await executeFile('/usr/bin/git', ['init', workspace]);
    await writeFile(join(workspace, '.gitignore'), 'MEMORY.md\nnode_modules/\nother/\n');
    for (const directory of ['node_modules/pkg', 'other']) {
      await mkdir(join(workspace, directory), { recursive: true });
      await writeFile(join(workspace, directory, 'MEMORY.md'), 'nested');
    }
    const rootOnly = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: {
        gitIgnore: true,
        include: ['{MEMORY,DREAMS,BOOTSTRAP}.md', '{absent,optional}.md'],
      },
    });
    assert.ok(rootOnly.files.includes('MEMORY.md'));
    assert.ok(!rootOnly.files.includes('other/MEMORY.md'));
    assert.ok(!rootOnly.files.includes('node_modules/pkg/MEMORY.md'));
    assert.deepEqual(
      rootOnly.diagnostics
        .filter(({ code }) => code === 'backup-include-unmatched')
        .map(({ path }) => path),
      ['{absent,optional}.md'],
    );
    const recursive = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { gitIgnore: true, include: ['**/MEMORY.md'] },
    });
    assert.ok(recursive.files.includes('other/MEMORY.md'));
    assert.ok(recursive.files.includes('node_modules/pkg/MEMORY.md'));
  });

  it('should prune excluded directories without changing direct dotfile glob semantics', async () => {
    await mkdir(join(workspace, 'scratch', 'excluded'), { recursive: true });
    await writeFile(join(workspace, 'scratch', '.keep'), 'selected');
    await writeFile(join(workspace, 'scratch', 'excluded', '.omit'), 'excluded by ancestor');
    const result = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { exclude: ['scratch/**'] },
    });
    assert.ok(result.files.includes('scratch/.keep'));
    assert.ok(!result.files.includes('scratch/excluded/.omit'));
  });

  it('should not inspect descendants of irrelevant ignored excluded or dependency directories', async () => {
    await executeFile('/usr/bin/git', ['init', workspace]);
    await writeFile(join(workspace, '.gitignore'), '.agent-system/worktrees/\n');
    for (const directory of ['.agent-system/worktrees', 'scratch', 'node_modules']) {
      await mkdir(join(workspace, directory), { recursive: true });
      await writeFile(join(workspace, directory, 'unsafe:path'), 'must not be visited');
    }
    const result = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: {
        gitIgnore: true,
        include: ['{MEMORY,DREAMS,BOOTSTRAP}.md'],
        exclude: ['scratch'],
      },
    });
    assert.ok(result.files.includes('MEMORY.md'));
    assert.ok(!result.files.some((path) => path.includes('unsafe:path')));
  });

  it('should exclude effective default and aliased destinations despite includes', async () => {
    await mkdir(join(workspace, '.agent-system', 'backups'), { recursive: true });
    await writeFile(join(workspace, '.agent-system', 'backups', 'old.tar.gz'), 'old');
    await mkdir(join(workspace, 'custom'));
    await writeFile(join(workspace, 'custom', 'old.tar.gz'), 'old');
    await symlink('custom', join(workspace, 'alias'));
    const result = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { output: 'alias', include: ['**', 'alias', '.agent-system/backups'] },
    });
    assert.equal(result.settings.output, join(workspace, 'custom'));
    assert.ok(
      !result.files.some(
        (path) =>
          path.startsWith('custom') ||
          path.startsWith('alias') ||
          path.startsWith('.agent-system/backups'),
      ),
    );
    await assert.rejects(
      service.plan({ manifest, workspaceDir: workspace, overrides: { output: root } }),
      /ancestor/u,
    );
  });

  it('should enforce bound destinations and exclude resolved runtime databases and sidecars', async () => {
    const database = join(workspace, 'custom-memory.sqlite');
    await writeFile(database, 'database');
    await writeFile(`${database}-wal`, 'wal');
    const protectedService = new WorkspaceBackupService(async () => ({
      paths: [database, `${database}-wal`],
    }));
    const result = await protectedService.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { include: ['**'] },
    });
    assert.ok(!result.files.includes('custom-memory.sqlite'));
    assert.ok(!result.files.includes('custom-memory.sqlite-wal'));
    assert.equal(result.coverage.openclawState, 'off');
    await assert.rejects(
      service.plan({
        manifest,
        workspaceDir: workspace,
        bound: true,
        overrides: { output: join(root, 'other') },
      }),
      /bound caller/u,
    );
    const configured = { ...manifest, backup: { output: join(root, 'configured') } };
    assert.equal(
      (await service.plan({ manifest: configured, workspaceDir: workspace, bound: true })).settings
        .output,
      configured.backup.output,
    );
  });

  it('should preview without any filesystem mutation or destination creation', async () => {
    const before = await readdir(workspace);
    const plan = await service.plan({ manifest, workspaceDir: workspace });
    assert.ok(plan.files.includes('memory/daily.md'));
    assert.deepEqual(await readdir(workspace), before);
    await assert.rejects(lstat(plan.settings.output), { code: 'ENOENT' });
  });

  it('should capture the host workspace beneath state while protecting runtime paths and destinations', async () => {
    const stateDir = join(root, '.openclaw');
    const hostWorkspace = join(stateDir, 'workspace-tanaabot');
    const agentDir = join(stateDir, 'agents', 'tanaabot', 'agent');
    const nestedRuntime = join(hostWorkspace, 'private-runtime');
    await mkdir(agentDir, { recursive: true });
    await mkdir(nestedRuntime, { recursive: true });
    await writeFile(join(agentDir, 'state.sqlite'), 'outside runtime');
    await writeFile(join(nestedRuntime, 'state.sqlite'), 'nested runtime');
    await writeFile(join(hostWorkspace, 'MEMORY.md'), 'workspace memory');
    await symlink(agentDir, join(hostWorkspace, 'runtime-alias'));
    const protection = {
      paths: [agentDir, nestedRuntime],
      stateDir,
      workspaceDir: hostWorkspace,
    };
    const protectedService = new WorkspaceBackupService(async () => protection);
    const plan = await protectedService.plan({
      manifest,
      workspaceDir: hostWorkspace,
      overrides: { include: ['**'] },
    });
    assert.ok(plan.files.includes('MEMORY.md'));
    assert.ok(!plan.files.some((path) => path.startsWith('private-runtime')));
    assert.ok(!plan.files.includes('runtime-alias'));
    const result = await protectedService.create(plan);
    assert.ok(result.manifest.inventory.some(({ path }) => path === 'MEMORY.md'));
    assert.ok(!result.manifest.inventory.some(({ path }) => path.includes('state.sqlite')));
    await protectedService.verify(result.archive);
    for (const output of [agentDir, join(stateDir, 'unowned-backups'), 'runtime-alias']) {
      await assert.rejects(
        protectedService.plan({
          manifest,
          workspaceDir: hostWorkspace,
          overrides: { output },
        }),
        { code: 'backup-output-is-runtime-state' },
      );
    }
    await assert.rejects(protectedService.plan({ manifest, workspaceDir: stateDir }), {
      code: 'backup-workspace-is-runtime-state',
    });
    await assert.rejects(protectedService.plan({ manifest, workspaceDir: agentDir }), {
      code: 'backup-workspace-is-runtime-state',
    });
    const otherWorkspace = join(stateDir, 'workspace-other');
    await mkdir(otherWorkspace);
    await assert.rejects(protectedService.plan({ manifest, workspaceDir: otherWorkspace }), {
      code: 'backup-workspace-is-runtime-state',
    });
    const unsafeService = new WorkspaceBackupService(async () => ({
      ...protection,
      workspaceDir: agentDir,
    }));
    await assert.rejects(unsafeService.plan({ manifest, workspaceDir: agentDir }), {
      code: 'backup-workspace-is-runtime-state',
    });
  });

  it('should reject special files only when selected after exclusions', async () => {
    await mkdir(join(workspace, 'scratch'));
    await executeFile('/usr/bin/mkfifo', [join(workspace, 'scratch', 'pipe')]);
    const plan = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { include: ['scratch/pipe'], exclude: ['scratch/**'] },
    });
    assert.ok(!plan.files.includes('scratch/pipe'));
    const result = await service.create(plan);
    assert.ok(result.manifest.inventory.some(({ path }) => path === 'MEMORY.md'));
    assert.ok(!result.manifest.inventory.some(({ path }) => path === 'scratch/pipe'));
    await assert.rejects(service.plan({ manifest, workspaceDir: workspace }), {
      code: 'backup-source-type-unsupported',
    });
  });

  it('should create private verified archives and preserve contents permissions and safe links on extraction', async () => {
    await writeFile(join(workspace, 'run.sh'), '#!/bin/sh\necho hello\n');
    await chmod(join(workspace, 'run.sh'), 0o755);
    await symlink('MEMORY.md', join(workspace, 'memory-link'));
    await symlink(root, join(workspace, 'escape'));
    const plan = await service.plan({ manifest, workspaceDir: workspace });
    assert.ok(!plan.files.includes('escape'));
    assert.ok(plan.diagnostics.some(({ code }) => code === 'backup-symlink-omitted'));
    const result = await service.create(plan);
    assert.equal((await lstat(result.archive)).mode & 0o777, 0o600);
    assert.equal(
      (await lstat(join(workspace, '.agent-system', 'backup-staging'))).mode & 0o777,
      0o700,
    );
    assert.deepEqual(await service.verify(result.archive), result.manifest);
    const restored = join(root, 'restored');
    await mkdir(restored);
    await executeFile('/usr/bin/tar', ['-xzf', result.archive, '-C', restored]);
    assert.equal(
      await readFile(join(restored, 'workspace', 'MEMORY.md'), 'utf8'),
      'private memory\n',
    );
    assert.equal(
      await readFile(join(restored, 'workspace', 'memory-link'), 'utf8'),
      'private memory\n',
    );
    assert.equal((await lstat(join(restored, 'workspace', 'run.sh'))).mode & 0o777, 0o755);
    assert.equal(result.manifest.coverage.stage, 'workspace-only');
    const next = await service.create(await service.plan({ manifest, workspaceDir: workspace }));
    assert.notEqual(next.archive, result.archive);
    assert.ok(
      !next.manifest.inventory.some(
        ({ path }) =>
          path.startsWith('.agent-system/backups/') ||
          path.startsWith('.agent-system/backup-staging/'),
      ),
    );
  });

  it('should establish narrow local git ignores without changing repository rules', async () => {
    await executeFile('/usr/bin/git', ['init', workspace]);
    await writeFile(join(workspace, '.gitignore'), '# unrelated\n*.tar\n');
    const result = await service.create(await service.plan({ manifest, workspaceDir: workspace }));
    await executeFile('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', result.archive]);
    const source = await readFile(join(workspace, '.gitignore'), 'utf8');
    assert.equal(source, '# unrelated\n*.tar\n');
    const exclude = await readFile(join(workspace, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.includes('/.agent-system/backups/'));
    assert.ok(!exclude.includes('\n/.agent-system/\n'));
  });

  it('should serialize concurrent creation and publish distinct complete archives', async () => {
    const plan = await service.plan({ manifest, workspaceDir: workspace });
    const results = await Promise.all([service.create(plan), service.create(plan)]);
    assert.notEqual(results[0]!.archive, results[1]!.archive);
    for (const result of results) await service.verify(result.archive);
    assert.deepEqual(await readdir(join(workspace, '.agent-system', 'backup-staging')), []);
  });

  it('should reject another agent and corrupt gzip without live workspace changes', async () => {
    const result = await service.create(await service.plan({ manifest, workspaceDir: workspace }));
    await assert.rejects(service.verify(result.archive, 'other'), /another agent/u);
    const bad = join(root, 'bad.tar.gz');
    await writeFile(bad, (await readFile(result.archive)).subarray(0, 40));
    await assert.rejects(service.verify(bad), /valid gzip/u);
    assert.equal(await readFile(join(workspace, 'MEMORY.md'), 'utf8'), 'private memory\n');
  });

  it('should reject mismatched checksums and unsafe inventory without publishing', async () => {
    const result = await service.create(await service.plan({ manifest, workspaceDir: workspace }));
    const fake = structuredClone(result.manifest);
    fake.inventory.find(({ path }) => path === 'MEMORY.md')!.sha256 = '0'.repeat(64);
    const corrupt = join(root, 'corrupt.tar.gz');
    await writeWorkspaceArchive(corrupt, workspace, fake);
    await assert.rejects(verifyWorkspaceArchive(corrupt), /checksum/u);
    fake.inventory[0]!.path = '../escape';
    await assert.rejects(
      writeWorkspaceArchive(join(root, 'unsafe.tar.gz'), workspace, fake),
      /unsafe/u,
    );
  });

  it('should reject raw traversal duplicate and missing payload entries', async () => {
    const result = await service.create(await service.plan({ manifest, workspaceDir: workspace }));
    for (const name of ['workspace/../escape', 'workspace/MEMORY.md']) {
      const stream = pack();
      const archive = join(
        root,
        `malicious-${name.includes('..') ? 'traversal' : 'duplicate'}.tar.gz`,
      );
      const writing = pipeline(stream, createGzip(), createWriteStream(archive));
      stream.entry({ name: 'manifest.json', type: 'file' }, JSON.stringify(result.manifest));
      stream.entry({ name: 'workspace/', type: 'directory' });
      if (!name.includes('..')) {
        const original = result.manifest.inventory.find(({ path }) => path === 'MEMORY.md')!;
        stream.entry({ name, type: 'file', mode: original.mode }, 'private memory\n');
      }
      stream.entry({ name, type: 'file' }, 'private memory\n');
      stream.finalize();
      await writing;
      await assert.rejects(service.verify(archive), /unsafe or duplicate/u);
      const recovery = join(root, 'malicious-recovery');
      await assert.rejects(service.restore(archive, recovery), /unsafe or duplicate/u);
      await assert.rejects(lstat(recovery), { code: 'ENOENT' });
      await assert.rejects(lstat(join(root, 'escape')), { code: 'ENOENT' });
    }
    const empty = join(root, 'missing.tar.gz');
    const stream = pack();
    const writing = pipeline(stream, createGzip(), createWriteStream(empty));
    stream.entry({ name: 'manifest.json', type: 'file' }, JSON.stringify(result.manifest));
    stream.entry({ name: 'workspace/', type: 'directory' });
    stream.finalize();
    await writing;
    await assert.rejects(service.verify(empty), /missing inventoried/u);
  });

  it('should refuse escaping links before creating a recovery target', async () => {
    await symlink('MEMORY.md', join(workspace, 'memory-link'));
    const result = await service.create(await service.plan({ manifest, workspaceDir: workspace }));
    const forged = structuredClone(result.manifest);
    const link = forged.inventory.find(({ path }) => path === 'memory-link')!;
    link.linkTarget = '../../outside';
    const archive = join(root, 'escaping-link.tar.gz');
    const stream = pack();
    const writing = pipeline(stream, createGzip(), createWriteStream(archive));
    stream.entry({ name: 'manifest.json', type: 'file' }, JSON.stringify(forged));
    stream.finalize();
    await writing;
    const target = join(root, 'escaping-link-recovery');
    await assert.rejects(service.restore(archive, target), { code: 'backup-inventory-invalid' });
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  });

  it('should filter regenerable directories and allow an explicit include to recover them', async () => {
    await mkdir(join(workspace, 'node_modules', 'example'), { recursive: true });
    await writeFile(join(workspace, 'node_modules', 'example', 'index.js'), 'module');
    const result = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { include: ['memory/**'] },
    });
    assert.ok(!result.files.some((path) => path.startsWith('node_modules')));
    const recovered = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { include: ['node_modules/example/**'] },
    });
    assert.ok(recovered.files.includes('node_modules/example/index.js'));
  });

  it('should fail required-file and permission errors without publishing an archive', async function () {
    await assert.rejects(
      service.plan({ manifest, workspaceDir: workspace, overrides: { include: ['missing.md'] } }),
      /explicitly included path is missing/u,
    );
    const plan = await service.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { include: ['MEMORY.md'] },
    });
    await rm(join(workspace, 'MEMORY.md'));
    await assert.rejects(service.create(plan), /explicitly included path is missing/u);
    await assert.rejects(lstat(plan.settings.output), { code: 'ENOENT' });
    if (process.getuid?.() === 0) return;
    await writeFile(join(workspace, 'MEMORY.md'), 'private');
    await chmod(join(workspace, 'MEMORY.md'), 0o000);
    await assert.rejects(
      service.create(await service.plan({ manifest, workspaceDir: workspace })),
      { code: 'EACCES' },
    );
    assert.deepEqual(await readdir(plan.settings.output), []);
  });

  it('should allow trusted setup applies and restrict bound archive verification before reading', async () => {
    const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
      status: 'loaded',
      manifest,
      scope: { workspaceDir: workspace },
      path: join(workspace, 'agent.yaml'),
      digest: 'fixture',
      diagnostics: [],
      validationChecks: [],
    };
    const output: string[] = [];
    let exitCode = 0;
    const options = {
      service,
      manifestService: {
        async loadForAgentId() {
          return loaded;
        },
        async loadForCommandDirectory() {
          return loaded;
        },
      },
      workspaceDir: workspace,
      environment: {},
      json: true,
      output: {
        writeStdout(value: string) {
          output.push(value);
        },
        writeStderr() {},
      },
      setExitCode(code: number) {
        exitCode = code;
      },
      commandAuthority: {
        async resolve() {
          return {
            agentId: 'tanaabot',
            workingDirectory: workspace,
            admittedWorkingDirectories: [workspace],
            setupMode: 'apply' as const,
          };
        },
      },
    };
    await backupCreate({ ...options, dryRun: false, overrides: {} });
    const created = JSON.parse(output.pop()!);
    assert.equal(created.status, 'created');
    assert.equal(exitCode, 0);
    await backupVerify({ ...options, archive: created.archive });
    assert.equal(JSON.parse(output.pop()!).status, 'verified');
    await backupVerify({ ...options, archive: join(root, 'another-agent.tar.gz') });
    assert.equal(JSON.parse(output.pop()!).diagnostics[0].code, 'backup-archive-outside-scope');
    assert.equal(exitCode, 1);
    const target = join(root, 'bound-recovery');
    await backupRestore({ ...options, archive: created.archive, target });
    assert.equal(JSON.parse(output.pop()!).diagnostics[0].code, 'backup-restore-operator-only');
    await assert.rejects(lstat(target), { code: 'ENOENT' });
  });

  it('should reject configured destinations belonging to another agent before creating files', async () => {
    const external = join(root, 'other-workspace');
    const selected = { ...manifest, backup: { output: external } };
    const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
      status: 'loaded',
      manifest: selected,
      scope: { workspaceDir: workspace },
      path: join(workspace, 'agent.yaml'),
      digest: 'fixture',
      diagnostics: [],
      validationChecks: [],
    };
    const output: string[] = [];
    let exitCode = 0;
    await backupCreate({
      service,
      manifestService: {
        async loadForAgentId() {
          return loaded;
        },
        async loadForCommandDirectory() {
          return { ...loaded, manifest: { ...manifest, agent: { id: 'other' } } };
        },
      },
      workspaceDir: workspace,
      environment: {},
      json: true,
      dryRun: false,
      overrides: {},
      output: {
        writeStdout(value: string) {
          output.push(value);
        },
        writeStderr() {},
      },
      setExitCode(code: number) {
        exitCode = code;
      },
      commandAuthority: {
        async resolve() {
          return {
            agentId: 'tanaabot',
            workingDirectory: workspace,
            admittedWorkingDirectories: [workspace],
          };
        },
      },
    });
    assert.equal(JSON.parse(output.join('')).diagnostics[0].code, 'backup-location-agent-mismatch');
    assert.equal(exitCode, 1);
    await assert.rejects(lstat(external), { code: 'ENOENT' });
    await assert.rejects(lstat(join(workspace, '.agent-system')), { code: 'ENOENT' });
  });

  it('should reject unsafe globs and insecure staging rather than reporting success', async () => {
    await assert.rejects(
      planWorkspaceBackup({
        manifest,
        workspaceDir: workspace,
        overrides: { include: ['../other'] },
      }),
      /relative/u,
    );
    await mkdir(join(workspace, '.agent-system', 'backup-staging'), {
      recursive: true,
      mode: 0o755,
    });
    await chmod(join(workspace, '.agent-system', 'backup-staging'), 0o755);
    await assert.rejects(
      service.create(await service.plan({ manifest, workspaceDir: workspace })),
      /Unsafe backup directory/u,
    );
  });
});
