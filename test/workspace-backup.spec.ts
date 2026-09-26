import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { pack } from 'tar-stream';
import {
  chmod,
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
import { planWorkspaceBackup } from '../agent/backup-selection.ts';
import { verifyWorkspaceArchive, writeWorkspaceArchive } from '../agent/backup-archive.ts';
import type { AgentManifest } from '../manifest/types.ts';
import parseAgentManifest from '../manifest/parse.ts';
import backupCreate from '../cli/backup-create.ts';
import backupVerify from '../cli/backup-verify.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

const executeFile = promisify(execFile);
const manifest: AgentManifest = { schemaVersion: 1, agent: { id: 'tanaabot' } };

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

  it('should recover ignored descendants and let excludes win', async function () {
    this.timeout(10_000);
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

  it('should inherit defaults and replace or clear manifest lists', async () => {
    const configured = {
      ...manifest,
      backup: {
        output: 'private',
        gitIgnore: false,
        include: ['MEMORY.md'],
        exclude: ['MEMORY.md'],
      },
    };
    const result = await service.plan({
      manifest: configured,
      workspaceDir: workspace,
      overrides: { include: [], exclude: ['memory/**'] },
    });
    assert.deepEqual(result.settings.include, []);
    assert.deepEqual(result.settings.exclude, ['memory/**']);
    assert.equal(result.settings.output, join(workspace, 'private'));
    assert.ok(result.files.includes('MEMORY.md'));
    assert.ok(!result.files.includes('memory/daily.md'));
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
    const protectedService = new WorkspaceBackupService(async () => [database, `${database}-wal`]);
    const result = await protectedService.plan({
      manifest,
      workspaceDir: workspace,
      overrides: { include: ['**'] },
    });
    assert.ok(!result.files.includes('custom-memory.sqlite'));
    assert.ok(!result.files.includes('custom-memory.sqlite-wal'));
    assert.equal(result.coverage.openclawState, 'unsupported');
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
