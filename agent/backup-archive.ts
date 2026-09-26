import { createHash } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import { extract, pack, type Header } from 'tar-stream';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { externalBackupSchema } from '../manifest/backup-schema.ts';
import { safeBackupRelativePath } from './backup-selection.ts';
import { BackupError, type BackupEntry, type WorkspaceBackupManifest } from './backup-types.ts';

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
const manifestSchema = Type.Object(
  {
    format: Type.Literal('agent-system-backup'),
    version: Type.Literal(1),
    agentId: Type.String({ pattern: '^[a-z0-9][a-z0-9-]*$' }),
    capturedAt: Type.String(),
    settings: Type.Object(
      {
        output: Type.String(),
        gitIgnore: Type.Boolean(),
        include: Type.Array(Type.String()),
        exclude: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
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
    inventory: Type.Array(entrySchema, { maxItems: 100_000 }),
    diagnostics: Type.Array(diagnosticSchema),
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
  if (!Value.Check(manifestSchema, manifest) || !Number.isFinite(Date.parse(manifest.capturedAt))) {
    throw new BackupError(
      'backup-manifest-invalid',
      'The archive manifest is invalid or its format/version is unsupported.',
    );
  }
  const external = {
    output: manifest.settings.output,
    'git-ignore': manifest.settings.gitIgnore,
    include: manifest.settings.include,
    exclude: manifest.settings.exclude,
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
): Promise<void> {
  validateInventory(manifest);
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
  }
}
