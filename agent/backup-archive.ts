import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import { extract, pack, type Header } from 'tar-stream';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { externalBackupSchema } from '../manifest/backup-schema.ts';
import { safeBackupRelativePath } from './backup-selection.ts';
import {
  BackupError,
  type BackupEntry,
  type OpenClawSnapshotManifest,
  type WorkspaceBackupManifest,
} from './backup-types.ts';

const maximumManifestBytes = 16 * 1024 * 1024;
const diagnosticSchema = Type.Object(
  { code: Type.String(), message: Type.String(), path: Type.Optional(Type.String()) },
  { additionalProperties: false },
);
const entrySchema = Type.Object(
  {
    path: Type.String(),
    type: Type.Union([Type.Literal('file'), Type.Literal('directory'), Type.Literal('symlink')]),
    mode: Type.Integer({ minimum: 0, maximum: 0o777 }),
    size: Type.Integer({ minimum: 0 }),
    sha256: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
    linkTarget: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const manifestBase = {
  format: Type.Literal('agent-system-backup'),
  agentId: Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$' }),
  capturedAt: Type.String(),
  inventory: Type.Array(entrySchema, { maxItems: 100_000 }),
  diagnostics: Type.Array(diagnosticSchema),
};
const legacySettingsSchema = Type.Object(
  {
    output: Type.String(),
    gitIgnore: Type.Boolean(),
    include: Type.Array(Type.String()),
    exclude: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
const snapshotManifestSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    snapshotId: Type.String({ pattern: '^[a-zA-Z0-9-]+$' }),
    createdAt: Type.String(),
    database: Type.Object(
      {
        role: Type.Literal('agent'),
        agentId: Type.String(),
        basename: Type.Literal('openclaw-agent.sqlite'),
        userVersion: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
    artifact: Type.Object(
      {
        path: Type.Literal('database.sqlite'),
        sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
        sizeBytes: Type.Integer({ minimum: 1 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const legacyManifestSchema = Type.Object(
  {
    ...manifestBase,
    version: Type.Literal(1),
    settings: legacySettingsSchema,
    coverage: Type.Object(
      {
        stage: Type.Literal('workspace-only'),
        openclawState: Type.Literal('unsupported'),
        atomic: Type.Literal(false),
        omittedPaths: Type.Array(Type.String()),
        limitations: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const currentManifestSchema = Type.Object(
  {
    ...manifestBase,
    version: Type.Literal(2),
    settings: Type.Object(
      {
        ...legacySettingsSchema.properties,
        openclawState: Type.Union([
          Type.Literal('auto'),
          Type.Literal('required'),
          Type.Literal('off'),
        ]),
      },
      { additionalProperties: false },
    ),
    coverage: Type.Object(
      {
        stage: Type.Union([
          Type.Literal('workspace-only'),
          Type.Literal('workspace-and-agent-state'),
        ]),
        openclawState: Type.Union([
          Type.Literal('captured'),
          Type.Literal('absent'),
          Type.Literal('off'),
        ]),
        atomic: Type.Literal(false),
        omittedPaths: Type.Array(Type.String()),
        limitations: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    snapshot: Type.Optional(
      Type.Object(
        {
          manifest: snapshotManifestSchema,
          openclawVersion: Type.String({ minLength: 1 }),
          agentSystemVersion: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export function safeBackupLink(path: string, target: string): boolean {
  if (
    !target ||
    target.startsWith('/') ||
    /[:\\]/u.test(target) ||
    Array.from(target).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  return safeBackupRelativePath(resolved);
}

function validateInventory(manifest: WorkspaceBackupManifest): void {
  if (
    !(manifest.version === 1
      ? Value.Check(legacyManifestSchema, manifest)
      : Value.Check(currentManifestSchema, manifest)) ||
    !Number.isFinite(Date.parse(manifest.capturedAt))
  ) {
    throw new BackupError(
      'backup-manifest-invalid',
      'The archive manifest is invalid or its format/version is unsupported.',
    );
  }
  if (
    manifest.version === 2 &&
    ((manifest.coverage.openclawState === 'captured') !== Boolean(manifest.snapshot) ||
      (manifest.coverage.stage === 'workspace-and-agent-state') !== Boolean(manifest.snapshot) ||
      (manifest.snapshot && manifest.snapshot.manifest.database.agentId !== manifest.agentId))
  )
    throw new BackupError('backup-manifest-invalid', 'The snapshot coverage is inconsistent.');
  const external = {
    output: manifest.settings.output,
    'git-ignore': manifest.settings.gitIgnore,
    include: manifest.settings.include,
    exclude: manifest.settings.exclude,
    ...(manifest.version === 2 ? { 'openclaw-state': manifest.settings.openclawState } : {}),
  };
  if (!Value.Check(externalBackupSchema, external))
    throw new BackupError('backup-settings-invalid', 'The archive selection settings are invalid.');
  const entries = new Map<string, BackupEntry>();
  for (const entry of manifest.inventory) {
    if (
      !safeBackupRelativePath(entry.path) ||
      entries.has(entry.path) ||
      !Number.isSafeInteger(entry.size)
    )
      throw new BackupError(
        'backup-inventory-invalid',
        'The archive inventory contains an unsafe or duplicate path.',
      );
    if (
      entry.type === 'file'
        ? !entry.sha256 || entry.linkTarget !== undefined
        : entry.size !== 0 ||
          entry.sha256 !== undefined ||
          (entry.type === 'symlink'
            ? !entry.linkTarget || !safeBackupLink(entry.path, entry.linkTarget)
            : entry.linkTarget !== undefined)
    ) {
      throw new BackupError('backup-inventory-invalid', `Invalid inventory entry: ${entry.path}.`);
    }
    entries.set(entry.path, entry);
  }
  for (const entry of entries.values()) {
    let parent = dirname(entry.path);
    while (parent !== '.') {
      if (entries.get(parent)?.type !== 'directory')
        throw new BackupError(
          'backup-inventory-invalid',
          'Every payload ancestor must be an inventoried directory.',
        );
      parent = dirname(parent);
    }
    if (entry.type === 'symlink') {
      const visited = new Set<string>([entry.path]);
      let target = posix.normalize(posix.join(posix.dirname(entry.path), entry.linkTarget!));
      while (true) {
        if (visited.has(target))
          throw new BackupError('backup-link-invalid', 'The inventory contains a cyclic link.');
        visited.add(target);
        const linked = entries.get(target);
        if (!linked)
          throw new BackupError(
            'backup-link-invalid',
            'A link target is outside the inventoried payload.',
          );
        if (linked.type !== 'symlink') break;
        target = posix.normalize(posix.join(posix.dirname(target), linked.linkTarget!));
      }
    }
  }
}

/** write only inventoried private copies; never let tar traverse a live directory. */
export async function writeWorkspaceArchive(
  archive: string,
  stage: string,
  manifest: WorkspaceBackupManifest,
  signal?: AbortSignal,
  snapshotDirectory?: string,
): Promise<void> {
  validateInventory(manifest);
  if (manifest.version === 2 && manifest.snapshot && !snapshotDirectory)
    throw new BackupError('backup-snapshot-missing', 'The captured snapshot directory is missing.');
  const source = Buffer.from(`${JSON.stringify(manifest)}\n`);
  if (source.length > maximumManifestBytes)
    throw new BackupError(
      'backup-manifest-too-large',
      'The archive inventory exceeds the supported manifest size.',
    );
  const stream = pack();
  const writing = pipeline(
    stream,
    createGzip(),
    createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  // attach rejection immediately; producers may still be adding entries when disk I/O fails.
  void writing.catch(() => undefined);
  const add = (header: Partial<Header> & Pick<Header, 'name'>, content: Buffer) =>
    new Promise<void>((resolve, reject) =>
      stream.entry(header, content, (error) => (error ? reject(error) : resolve())),
    );
  try {
    await add(
      { name: 'manifest.json', type: 'file', mode: 0o600, mtime: new Date(manifest.capturedAt) },
      source,
    );
    await add({ name: 'workspace/', type: 'directory', mode: 0o700 }, Buffer.alloc(0));
    for (const entry of manifest.inventory) {
      signal?.throwIfAborted();
      const header: Partial<Header> & Pick<Header, 'name'> = {
        name: `workspace/${entry.path}${entry.type === 'directory' ? '/' : ''}`,
        type: entry.type,
        mode: entry.mode,
        size: entry.size,
        mtime: new Date(manifest.capturedAt),
        ...(entry.linkTarget === undefined ? {} : { linkname: entry.linkTarget }),
      };
      if (entry.type === 'file')
        await pipeline(
          createReadStream(`${stage}/${entry.path}`),
          stream.entry(header) as unknown as Writable,
          { signal },
        );
      else await add(header, Buffer.alloc(0));
    }
    if (manifest.version === 2 && manifest.snapshot && snapshotDirectory) {
      await add({ name: 'openclaw-state/', type: 'directory', mode: 0o700 }, Buffer.alloc(0));
      for (const name of ['manifest.json', 'database.sqlite']) {
        const size =
          name === 'database.sqlite'
            ? manifest.snapshot.manifest.artifact.sizeBytes
            : (await stat(join(snapshotDirectory, name))).size;
        await pipeline(
          createReadStream(join(snapshotDirectory, name)),
          stream.entry({
            name: `openclaw-state/${name}`,
            type: 'file',
            mode: 0o600,
            size,
          }) as unknown as Writable,
          { signal },
        );
      }
    }
    stream.finalize();
    await writing;
  } catch (error) {
    stream.destroy(error as Error);
    await writing.catch(() => undefined);
    throw error;
  }
}

/** verify structure and content in streams without extracting or touching the live workspace. */
export async function verifyWorkspaceArchive(
  archive: string,
  expectedAgentId?: string,
  signal?: AbortSignal,
  verifySnapshot?: (directory: string, manifest: OpenClawSnapshotManifest) => Promise<void>,
): Promise<WorkspaceBackupManifest> {
  const handle = await open(
    archive,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const parser = extract();
  let manifest: WorkspaceBackupManifest | undefined;
  let inventory = new Map<string, BackupEntry>();
  const seen = new Set<string>();
  let root = false;
  let snapshotRoot = false;
  let snapshotScratch: string | undefined;
  let snapshotDirectory: string | undefined;
  const snapshotSeen = new Set<string>();
  const reading = pipeline(
    handle.createReadStream(),
    createGunzip(),
    parser as unknown as Writable,
    { signal },
  );
  void reading.catch(() => undefined);
  try {
    if (!(await handle.stat()).isFile())
      throw new BackupError('backup-archive-not-file', 'The archive must be a regular file.');
    for await (const entry of parser) {
      signal?.throwIfAborted();
      const header = entry.header;
      if (!Number.isSafeInteger(header.size) || header.size! < 0)
        throw new BackupError(
          'backup-entry-invalid',
          'The archive contains an invalid entry size.',
        );
      if (header.name === 'manifest.json' && !manifest) {
        if (header.type !== 'file' || header.size! > maximumManifestBytes)
          throw new BackupError(
            'backup-manifest-invalid',
            'The root manifest must be a bounded regular file.',
          );
        const chunks: Buffer[] = [];
        for await (const chunk of entry) chunks.push(Buffer.from(chunk as Uint8Array));
        try {
          manifest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WorkspaceBackupManifest;
        } catch {
          throw new BackupError('backup-manifest-invalid', 'The root manifest is not valid JSON.');
        }
        validateInventory(manifest);
        inventory = new Map(manifest.inventory.map((item) => [item.path, item]));
        if (expectedAgentId && manifest.agentId !== expectedAgentId)
          throw new BackupError('backup-agent-mismatch', 'The archive belongs to another agent.');
        continue;
      }
      if (!manifest)
        throw new BackupError(
          'backup-layout-invalid',
          'The root manifest must be the first archive entry.',
        );
      if (
        header.name === 'workspace/' &&
        !root &&
        header.type === 'directory' &&
        header.size === 0
      ) {
        root = true;
        entry.resume();
        continue;
      }
      if (
        manifest.version === 2 &&
        manifest.snapshot &&
        root &&
        header.name === 'openclaw-state/' &&
        !snapshotRoot &&
        header.type === 'directory' &&
        header.size === 0 &&
        header.mode === 0o700
      ) {
        snapshotRoot = true;
        snapshotScratch = await mkdtemp(join(tmpdir(), 'agent-system-verify-'));
        const repository = join(snapshotScratch, 'repository');
        await mkdir(repository, { mode: 0o700 });
        snapshotDirectory = join(repository, manifest.snapshot.manifest.snapshotId);
        await mkdir(snapshotDirectory, { mode: 0o700 });
        entry.resume();
        continue;
      }
      if (snapshotRoot && header.name.startsWith('openclaw-state/')) {
        const name = header.name.slice('openclaw-state/'.length);
        const expected = manifest.version === 2 ? manifest.snapshot?.manifest : undefined;
        if (
          !expected ||
          !snapshotDirectory ||
          (name !== 'manifest.json' && name !== 'database.sqlite') ||
          snapshotSeen.has(name) ||
          header.type !== 'file' ||
          header.mode !== 0o600 ||
          (name === 'manifest.json' && header.size! > 1024 * 1024) ||
          (name === 'database.sqlite' && header.size !== expected.artifact.sizeBytes)
        )
          throw new BackupError('backup-snapshot-invalid', 'Invalid embedded snapshot entry.');
        const output = await open(
          join(snapshotDirectory, name),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        const hash = createHash('sha256');
        try {
          for await (const chunk of entry) {
            const bytes = chunk as Uint8Array;
            hash.update(bytes);
            await output.writeFile(bytes);
          }
          await output.sync();
        } finally {
          await output.close();
        }
        if (name === 'database.sqlite' && hash.digest('hex') !== expected.artifact.sha256)
          throw new BackupError('backup-checksum-mismatch', 'The embedded database hash differs.');
        if (name === 'manifest.json') {
          let embedded: unknown;
          try {
            embedded = JSON.parse(await readFile(join(snapshotDirectory, name), 'utf8'));
          } catch {
            throw new BackupError(
              'backup-snapshot-invalid',
              'The embedded snapshot manifest is invalid.',
            );
          }
          if (!isDeepStrictEqual(embedded, expected))
            throw new BackupError(
              'backup-snapshot-invalid',
              'The embedded snapshot metadata differs.',
            );
        }
        snapshotSeen.add(name);
        continue;
      }
      if (!root || !header.name.startsWith('workspace/'))
        throw new BackupError(
          'backup-layout-invalid',
          'Unexpected archive entry outside workspace payload.',
        );
      const path = header.name.slice('workspace/'.length).replace(/\/$/u, '');
      if (!safeBackupRelativePath(path) || seen.has(path))
        throw new BackupError(
          'backup-path-unsafe',
          'The archive contains an unsafe or duplicate payload path.',
        );
      const expected = inventory.get(path);
      if (
        !expected ||
        header.type !== expected.type ||
        header.size !== expected.size ||
        header.mode !== expected.mode ||
        (header.linkname || undefined) !== expected.linkTarget
      )
        throw new BackupError(
          'backup-inventory-mismatch',
          `Archive entry differs from inventory: ${path}.`,
        );
      const hash = createHash('sha256');
      for await (const chunk of entry) hash.update(chunk as Uint8Array);
      if (expected.type === 'file' && hash.digest('hex') !== expected.sha256)
        throw new BackupError('backup-checksum-mismatch', `Archive checksum differs: ${path}.`);
      seen.add(path);
    }
    await reading;
    if (!manifest || !root || seen.size !== manifest.inventory.length)
      throw new BackupError(
        'backup-inventory-mismatch',
        'The archive is missing inventoried entries.',
      );
    if (manifest.version === 2 && manifest.snapshot) {
      if (!snapshotRoot || snapshotSeen.size !== 2 || !snapshotDirectory || !verifySnapshot)
        throw new BackupError(
          'backup-snapshot-invalid',
          'The embedded snapshot is incomplete or cannot be verified.',
        );
      await verifySnapshot(snapshotDirectory, manifest.snapshot.manifest);
    }
    return manifest;
  } catch (error) {
    parser.destroy(error as Error);
    await reading.catch(() => undefined);
    throw error instanceof BackupError
      ? error
      : new BackupError(
          'backup-archive-invalid',
          'The archive could not be read or is not a valid gzip tar archive.',
        );
  } finally {
    await handle.close();
    if (snapshotScratch) await rm(snapshotScratch, { recursive: true, force: true });
  }
}

/** read only the bounded first entry for retention; payload integrity is checked separately. */
export async function readWorkspaceArchiveMetadata(archive: string): Promise<{
  agentId: string;
  capturedAt: string;
}> {
  const handle = await open(
    archive,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const parser = extract();
  const reading = pipeline(
    handle.createReadStream(),
    createGunzip(),
    parser as unknown as Writable,
  );
  void reading.catch(() => undefined);
  try {
    if (!(await handle.stat()).isFile())
      throw new BackupError('backup-archive-not-file', 'Not a regular archive.');
    for await (const entry of parser) {
      if (
        entry.header.name !== 'manifest.json' ||
        entry.header.type !== 'file' ||
        !Number.isSafeInteger(entry.header.size) ||
        entry.header.size! < 0 ||
        entry.header.size! > maximumManifestBytes
      )
        throw new BackupError('backup-manifest-invalid', 'The bounded root manifest is missing.');
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(Buffer.from(chunk as Uint8Array));
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new BackupError('backup-manifest-invalid', 'The root manifest is not valid JSON.');
      }
      const candidate = value as Partial<WorkspaceBackupManifest> | null;
      if (
        !candidate ||
        candidate.format !== 'agent-system-backup' ||
        (candidate.version !== 1 && candidate.version !== 2) ||
        typeof candidate.agentId !== 'string' ||
        !/^[a-z0-9][a-z0-9-]*$/u.test(candidate.agentId) ||
        typeof candidate.capturedAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(candidate.capturedAt) ||
        !Number.isFinite(Date.parse(candidate.capturedAt)) ||
        new Date(candidate.capturedAt).toISOString() !== candidate.capturedAt
      )
        throw new BackupError(
          'backup-manifest-invalid',
          'The archive retention metadata is invalid.',
        );
      validateInventory(candidate as WorkspaceBackupManifest);
      return { agentId: candidate.agentId, capturedAt: candidate.capturedAt };
    }
    throw new BackupError('backup-manifest-invalid', 'The archive has no root manifest.');
  } catch (error) {
    throw error instanceof BackupError
      ? error
      : new BackupError('backup-archive-invalid', 'The archive metadata could not be read.');
  } finally {
    parser.destroy();
    await reading.catch(() => undefined);
    await handle.close();
  }
}

/** extract a previously verified private archive without delegating path handling to tar. */
export async function extractWorkspaceArchive(
  archive: string,
  destination: string,
  manifest: WorkspaceBackupManifest,
  snapshotDirectory?: string,
): Promise<void> {
  validateInventory(manifest);
  const entries = new Map(manifest.inventory.map((entry) => [entry.path, entry]));
  const directories = manifest.inventory
    .filter((entry) => entry.type === 'directory')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  const workspace = join(destination, 'workspace');
  await mkdir(workspace, { mode: 0o700 });
  for (const directory of directories)
    await mkdir(join(workspace, directory.path), { mode: 0o700 });
  const parser = extract();
  const reading = pipeline(
    createReadStream(archive),
    createGunzip(),
    parser as unknown as Writable,
  );
  void reading.catch(() => undefined);
  const seen = new Set<string>();
  const snapshotSeen = new Set<string>();
  const links: BackupEntry[] = [];
  let rootManifest = false;
  let workspaceRoot = false;
  let snapshotRoot = false;
  try {
    for await (const entry of parser) {
      const { header } = entry;
      if (header.name === 'manifest.json' && !rootManifest) {
        const chunks: Buffer[] = [];
        for await (const chunk of entry) chunks.push(Buffer.from(chunk as Uint8Array));
        if (!isDeepStrictEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), manifest))
          throw new BackupError(
            'backup-manifest-invalid',
            'The archive changed after verification.',
          );
        const output = await open(
          join(destination, 'manifest.json'),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await output.writeFile(Buffer.concat(chunks));
        } finally {
          await output.close();
        }
        rootManifest = true;
        continue;
      }
      if (header.name === 'workspace/' && !workspaceRoot && header.type === 'directory') {
        workspaceRoot = true;
        entry.resume();
        continue;
      }
      if (
        header.name === 'openclaw-state/' &&
        !snapshotRoot &&
        snapshotDirectory &&
        header.type === 'directory'
      ) {
        snapshotRoot = true;
        entry.resume();
        continue;
      }
      if (snapshotDirectory && snapshotRoot && header.name.startsWith('openclaw-state/')) {
        const name = header.name.slice('openclaw-state/'.length);
        if (
          (name !== 'manifest.json' && name !== 'database.sqlite') ||
          snapshotSeen.has(name) ||
          header.type !== 'file'
        )
          throw new BackupError('backup-snapshot-invalid', 'The embedded snapshot changed.');
        const output = await open(
          join(snapshotDirectory, name),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          for await (const chunk of entry) await output.writeFile(chunk as Uint8Array);
        } finally {
          await output.close();
        }
        snapshotSeen.add(name);
        continue;
      }
      if (!workspaceRoot || !header.name.startsWith('workspace/'))
        throw new BackupError('backup-layout-invalid', 'The archive changed after verification.');
      const path = header.name.slice('workspace/'.length).replace(/\/$/u, '');
      const expected = entries.get(path);
      if (
        !safeBackupRelativePath(path) ||
        !expected ||
        seen.has(path) ||
        header.type !== expected.type ||
        header.mode !== expected.mode ||
        header.size !== expected.size ||
        (header.linkname || undefined) !== expected.linkTarget
      )
        throw new BackupError(
          'backup-inventory-mismatch',
          'The archive changed after verification.',
        );
      if (expected.type === 'file') {
        const output = await open(
          join(workspace, path),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        const hash = createHash('sha256');
        try {
          for await (const chunk of entry) {
            const bytes = chunk as Uint8Array;
            hash.update(bytes);
            await output.writeFile(bytes);
          }
        } finally {
          await output.close();
        }
        if (hash.digest('hex') !== expected.sha256)
          throw new BackupError('backup-checksum-mismatch', `Archive checksum differs: ${path}.`);
        await chmod(join(workspace, path), expected.mode);
      } else {
        entry.resume();
        if (expected.type === 'symlink') links.push(expected);
      }
      seen.add(path);
    }
    await reading;
    if (
      !rootManifest ||
      !workspaceRoot ||
      seen.size !== entries.size ||
      (snapshotDirectory && (!snapshotRoot || snapshotSeen.size !== 2))
    )
      throw new BackupError('backup-inventory-mismatch', 'The archive changed after verification.');
    for (const link of links) await symlink(link.linkTarget!, join(workspace, link.path));
    for (const directory of directories.reverse())
      await chmod(join(workspace, directory.path), directory.mode);
  } catch (error) {
    parser.destroy(error as Error);
    await reading.catch(() => undefined);
    throw error;
  }
}
