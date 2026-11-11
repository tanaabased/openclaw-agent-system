import { join } from 'node:path';
import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';
import { automationHash } from './automation-hash.ts';

export interface DirectEntryBinding {
  runtime: 'codex' | 'openclaw';
  agentId: string;
  workspace: string;
  namespace: string;
  session: string;
  incarnation: string;
}

/** direct operation custody uses existing private-file and lease primitives, never an intake event. */
export class DirectEntryStore<S extends TSchema> {
  readonly scope: string;
  readonly path: string;
  private readonly file: PrivateStateFile;
  constructor(
    private readonly root: string,
    binding: DirectEntryBinding,
    private readonly entriesSchema: S,
    private readonly kind: 'implementation' | 'native-retirement',
  ) {
    this.scope = automationHash(binding);
    this.path = join(root, `github-${kind}-${this.scope}.json`);
    this.file = new PrivateStateFile({
      currentUid: process.getuid?.(),
      directories: [root],
      label: `direct ${this.kind} entries`,
      maximumBytes: 8 * 1024 * 1024,
      path: this.path,
    });
  }
  async exclusive<T>(
    run: (entries: Static<S>, save: (removeEmpty?: boolean) => Promise<void>) => Promise<T>,
  ) {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: `direct ${this.kind} entries`,
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await withPrivateStateLock(lock, async () => {
        const schema = Type.Unsafe<{ scope: string; entries: Static<S> }>(
          Type.Object(
            { scope: Type.String(), entries: this.entriesSchema },
            { additionalProperties: false },
          ),
        );
        const contents = await this.file.read();
        const state: unknown =
          contents === undefined ? { scope: this.scope, entries: [] } : JSON.parse(contents);
        if (!Value.Check(schema, state) || state.scope !== this.scope)
          throw new Error(`${this.kind}-state-invalid`);
        return run(state.entries, async (removeEmpty = false) => {
          lock.assertHeld();
          if (!Value.Check(schema, state)) throw new Error(`${this.kind}-state-invalid`);
          if (removeEmpty && Array.isArray(state.entries) && state.entries.length === 0)
            await this.file.remove();
          else await this.file.write(JSON.stringify(state));
        });
      });
    } finally {
      await lock.release();
    }
  }
}
