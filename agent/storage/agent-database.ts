import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

import ensurePrivateStateDirectories, {
  assertPrivateDirectory,
} from '../../core/ensure-private-state-directories.ts';
import type { AgentSystemLifecycleOutcome } from '../../core/lifecycle-registry.ts';

export class AgentDatabase {
  readonly path: string;

  constructor(
    private readonly root: string,
    name: string,
  ) {
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) throw new Error('invalid agent database name');
    this.path = join(root, name + '.sqlite');
  }

  /** Normal clients open an installed database; only Install creates it. */
  async open() {
    assertPrivateDirectory(await lstat(this.root), {
      currentUid: process.getuid?.(),
      label: 'agent storage',
    });
    const { db } = await this.connect(false);
    return db;
  }

  private async connect(create: boolean) {
    const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const file = await open(this.path, create ? flags | constants.O_CREAT : flags, 0o600);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error('agent storage requires a private, owned database file');
      return { db: drizzle({ client: new DatabaseSync(this.path) }), empty: stat.size === 0 };
    } finally {
      await file.close();
    }
  }

  async install(migrationsFolder: string): Promise<AgentSystemLifecycleOutcome> {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'agent storage',
    });
    const { db, empty } = await this.connect(true);
    try {
      migrate(db, { migrationsFolder });
      const changes = db.$client.prepare('SELECT total_changes() AS changes').get()?.changes;
      return {
        component: 'agent-storage',
        code: 'agent-storage-ready',
        status: empty ? 'created' : changes ? 'updated' : 'unchanged',
        message: `agent database: ${this.path}`,
      };
    } finally {
      db.$client.close();
    }
  }
}
