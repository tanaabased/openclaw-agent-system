import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import AgentSystemToolError from '../../api/error.ts';
import ensurePrivateStateDirectories from '../../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../../core/private-state-file-lock.ts';
import { assertGoogleResult, type default as GoogleClient } from './client.ts';
import type { GoogleCredentials } from './credentials.ts';

interface GoogleReceipt {
  generation: string;
  account: string;
  fingerprint: string;
  contents: string;
}

/** Own immutable credential generations; child processes work on disposable copies. */
export default class GoogleStore {
  constructor(
    private readonly rootDir: string | undefined,
    private readonly client: GoogleClient,
    private readonly currentUid = process.getuid?.(),
  ) {}

  #paths(agentId: string) {
    if (!this.rootDir || !/^[a-z0-9][a-z0-9-]*$/u.test(agentId))
      throw new AgentSystemToolError(
        'configuration_unavailable',
        'Google private state is unavailable.',
      );
    const root = resolve(this.rootDir);
    const directories = [
      root,
      join(root, agentId),
      join(root, agentId, 'tools'),
      join(root, agentId, 'tools', 'gog'),
    ];
    const directory = directories.at(-1)!;
    return {
      directory,
      directories,
      receipt: new PrivateStateFile({
        directories,
        path: join(directory, 'current.json'),
        label: 'Google installation receipt',
        maximumBytes: 4096,
        currentUid: this.currentUid,
      }),
    };
  }

  async #receipt(agentId: string): Promise<GoogleReceipt | undefined> {
    const source = await this.#paths(agentId).receipt.read();
    if (!source) return undefined;
    try {
      const value = JSON.parse(source);
      if (
        !/^[0-9a-f-]{36}$/u.test(value.generation) ||
        typeof value.account !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(value.fingerprint) ||
        !/^[a-f0-9]{64}$/u.test(value.contents)
      )
        throw new Error();
      return value;
    } catch {
      throw new AgentSystemToolError(
        'configuration_unavailable',
        'Google installation receipt is invalid. Run install.',
      );
    }
  }

  environment(home: string, password: string): Record<string, string> {
    return {
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: join(home, 'cache'),
      GOG_CONFIG_DIR: join(home, 'config'),
      GOG_DATA_DIR: join(home, 'data'),
      GOG_STATE_DIR: join(home, 'state'),
      GOG_CACHE_DIR: join(home, 'cache'),
      GOG_KEYRING_BACKEND: 'file',
      GOG_KEYRING_PASSWORD: password,
      GOG_AUTH_MODE: 'stored',
    };
  }

  async #copy(source: string, destination?: string): Promise<string> {
    const hash = createHash('sha256');
    let bytes = 0;
    let files = 0;
    const walk = async (path: string, relative: string): Promise<void> => {
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        stat.mode & 0o077 ||
        (this.currentUid !== undefined && stat.uid !== this.currentUid)
      )
        throw new Error('Google state must be privately owned regular files and directories.');
      if (stat.isDirectory()) {
        if (destination) await mkdir(join(destination, relative), { mode: 0o700 });
        for (const name of (await readdir(path)).sort())
          await walk(join(path, name), join(relative, name));
        return;
      }
      if (!stat.isFile() || stat.nlink !== 1 || ++files > 128 || stat.size > 1048576)
        throw new Error('Google state is invalid or too large.');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile())
          throw new Error('Google state changed while being inspected.');
        const content = await handle.readFile();
        bytes += content.length;
        if (bytes > 1048576) throw new Error('Google state exceeds the supported size.');
        hash.update(JSON.stringify(relative)).update(content);
        if (destination)
          await writeFile(join(destination, relative), content, { mode: 0o600, flag: 'wx' });
      } finally {
        await handle.close();
      }
    };
    // destination itself is a private mkdtemp; copy only the four explicitly owned path kinds.
    for (const kind of ['config', 'data', 'state', 'cache']) await walk(join(source, kind), kind);
    return hash.digest('hex');
  }

  async inspect(
    agentId: string,
    account: string,
    material: GoogleCredentials,
  ): Promise<'missing' | 'drift' | 'ready'> {
    const receipt = await this.#receipt(agentId);
    if (!receipt) return 'missing';
    if (receipt.account !== account || receipt.fingerprint !== material.fingerprint) return 'drift';
    const generation = join(this.#paths(agentId).directory, receipt.generation);
    const stat = await lstat(generation);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
      throw new Error('Google generation is unsafe.');
    return (await this.#copy(generation)) === receipt.contents ? 'ready' : 'drift';
  }

  async acquire(
    agentId: string,
    account: string,
    material: GoogleCredentials,
    workspaceDir?: string,
    excludedDirectories: readonly string[] = [],
    signal?: AbortSignal,
  ) {
    if ((await this.inspect(agentId, account, material)) !== 'ready')
      throw new AgentSystemToolError(
        'configuration_unavailable',
        'Google credentials require openclaw agent-system install.',
      );
    const receipt = (await this.#receipt(agentId))!;
    const home = await mkdtemp(join(tmpdir(), 'agent-system-google-'));
    try {
      const contents = await this.#copy(
        join(this.#paths(agentId).directory, receipt.generation),
        home,
      );
      if (contents !== receipt.contents)
        throw new Error('Google state changed while being copied.');
      if (workspaceDir)
        await this.client
          .withScope(excludedDirectories, signal)
          .checkVersion(this.environment(home, material.password), workspaceDir, account);
      return {
        environment: this.environment(home, material.password),
        sensitiveValues: material.sensitiveValues,
        async dispose() {
          await rm(home, { recursive: true, force: true });
        },
      };
    } catch (error) {
      await rm(home, { recursive: true, force: true });
      throw error;
    }
  }

  async reconcile(
    agentId: string,
    account: string,
    material: GoogleCredentials,
    workspaceDir: string,
    excludedDirectories: readonly string[] = [],
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const client = this.client.withScope(excludedDirectories);
    const paths = this.#paths(agentId);
    await ensurePrivateStateDirectories({
      directories: paths.directories,
      label: 'Google state',
      currentUid: this.currentUid,
    });
    const lock = await acquirePrivateStateFileLock(paths.directory, {
      staleMs: 120000,
      retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
    });
    try {
      const previous = await this.#receipt(agentId);
      const status = await this.inspect(agentId, account, material);
      if (status === 'ready') {
        const lease = await this.acquire(agentId, account, material);
        try {
          await client.verify(lease.environment, workspaceDir, account);
        } finally {
          await lease.dispose();
        }
        return 'unchanged';
      }
      const generation = randomUUID();
      const home = join(paths.directory, generation);
      await mkdir(home, { mode: 0o700 });
      let installed = false;
      try {
        for (const kind of ['config', 'data', 'state', 'cache'])
          await mkdir(join(home, kind), { mode: 0o700 });
        await writeFile(join(home, 'config', 'config.json'), '{"keyring_backend":"file"}\n', {
          mode: 0o600,
          flag: 'wx',
        });
        const environment = this.environment(home, material.password);
        // version checking also happens before imports, so unknown GoG versions cannot write state.
        await client.checkVersion(environment, workspaceDir, account);
        assertGoogleResult(
          await client.run(
            environment,
            workspaceDir,
            account,
            ['auth', 'credentials', '-'],
            material.clientJSON,
          ),
        );
        assertGoogleResult(
          await client.run(
            environment,
            workspaceDir,
            account,
            ['auth', 'tokens', 'import', '-'],
            material.tokenJSON,
          ),
        );
        await client.verify(environment, workspaceDir, account);
        const contents = await this.#copy(home);
        await paths.receipt.write(
          JSON.stringify({ generation, account, fingerprint: material.fingerprint, contents }),
        );
        installed = true;
        if (previous)
          await rm(join(paths.directory, previous.generation), { recursive: true, force: true });
        return status === 'missing' ? 'created' : 'updated';
      } finally {
        if (!installed) await rm(home, { recursive: true, force: true });
      }
    } finally {
      await lock.release();
    }
  }
}
