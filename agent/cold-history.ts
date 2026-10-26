import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import nodeErrorCode from '../utils/node-error-code.ts';
import { historyLifetimeMs, historyMaximumBytes, type HistoryReference } from './history-state.ts';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const namePattern = /^(\d+)-([a-f0-9]{64})\.json$/u;
const temporaryPattern = /^\.\d+-[a-f0-9]{64}\.json\.[a-f0-9-]+\.tmp$/u;

export function historyEvictions(
  entries: readonly { name: string; at: number; bytes: number }[],
  now: number,
  incoming = 0,
) {
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, incoming);
  return [...entries]
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
    .filter((entry) => {
      if (entry.at + historyLifetimeMs > now && bytes <= historyMaximumBytes) return false;
      bytes -= entry.bytes;
      return true;
    });
}

/** private, expendable evidence; never an execution-state loader. */
export default class ColdHistory {
  readonly directory: string;
  constructor(
    readonly root: string,
    readonly scope: string,
  ) {
    if (!/^[a-z0-9-]+$/u.test(scope)) throw new Error('history-scope-invalid');
    this.directory = join(root, 'history-' + scope);
  }

  private file(name: string) {
    if (!namePattern.test(name) && !temporaryPattern.test(name))
      throw new Error('history-reference-invalid');
    return new PrivateStateFile({
      path: join(this.directory, name),
      directories: [this.root, this.directory],
      currentUid: process.getuid?.(),
      label: 'retained workflow history',
      maximumBytes: historyMaximumBytes,
    });
  }

  location(reference: HistoryReference) {
    const name = `${reference.at}-${reference.digest}.json`;
    if (!namePattern.test(name)) throw new Error('history-reference-invalid');
    return join(this.directory, name);
  }

  /** serialize archive writers and budget eviction independently of the active journal. */
  async exclusive<T>(run: () => Promise<T>): Promise<T> {
    await ensurePrivateStateDirectories({
      directories: [this.root, this.directory],
      currentUid: process.getuid?.(),
      label: 'Retained workflow history',
    });
    const lock = await acquirePrivateStateFileLock(join(this.directory, 'budget'), {
      staleMs: 30000,
      retries: { retries: 40, factor: 1, minTimeout: 250, maxTimeout: 250 },
    });
    try {
      return await withPrivateStateLock(lock, run);
    } finally {
      await lock.release();
    }
  }

  async retain(value: unknown, at: number, now: number): Promise<HistoryReference> {
    const contents = JSON.stringify({ version: 1, value });
    const reference = { digest: digest(contents), at };
    if (at + historyLifetimeMs <= now) return reference;
    if (Buffer.byteLength(contents) > historyMaximumBytes) return reference;
    const names = await readdir(this.directory).catch((error) => {
      if (nodeErrorCode(error) === 'ENOENT') return [];
      throw error;
    });
    const retained = names.find(
      (name) => namePattern.test(name) && name.endsWith(`-${reference.digest}.json`),
    );
    if (retained) reference.at = Number(namePattern.exec(retained)![1]);
    const name = `${reference.at}-${reference.digest}.json`;
    const file = this.file(name);
    const existing = await file.read();
    if (existing !== undefined) {
      if (digest(existing) !== reference.digest) throw new Error('history-integrity-failed');
      return reference;
    }
    // reserve the incoming atomic temporary file before writing, not after exceeding the budget.
    await this.prune(now, Buffer.byteLength(contents));
    await file.write(contents);
    if ((await file.read()) !== contents) throw new Error('history-integrity-failed');
    return reference;
  }

  async read(
    reference: HistoryReference,
    now: number,
  ): Promise<{ status: 'available'; value: unknown } | { status: 'history-unavailable' }> {
    if (
      !/^[a-f0-9]{64}$/u.test(reference.digest) ||
      !Number.isSafeInteger(reference.at) ||
      reference.at < 0 ||
      reference.at + historyLifetimeMs <= now
    )
      return { status: 'history-unavailable' };
    try {
      const contents = await this.file(`${reference.at}-${reference.digest}.json`).read();
      if (contents === undefined || digest(contents) !== reference.digest)
        return { status: 'history-unavailable' };
      const decoded = JSON.parse(contents) as { version?: unknown; value?: unknown };
      if (decoded.version !== 1 || !Object.hasOwn(decoded, 'value'))
        return { status: 'history-unavailable' };
      return { status: 'available', value: decoded.value };
    } catch {
      return { status: 'history-unavailable' };
    }
  }

  async prune(now: number, incoming = 0) {
    if (incoming > historyMaximumBytes) throw new Error('history-snapshot-capacity');
    await ensurePrivateStateDirectories({
      directories: [this.root, this.directory],
      currentUid: process.getuid?.(),
      label: 'Retained workflow history',
    });
    const entries = [];
    for (const name of await readdir(this.directory)) {
      if (temporaryPattern.test(name)) {
        await this.file(name).remove();
        continue;
      }
      const match = namePattern.exec(name);
      if (!match) continue;
      const stat = await lstat(join(this.directory, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('history-file-invalid');
      entries.push({ name, at: Number(match[1]), bytes: stat.size });
    }
    for (const entry of historyEvictions(entries, now, incoming)) {
      await this.file(entry.name).remove();
    }
  }
}
