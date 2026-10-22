import { join } from 'node:path';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { assessmentEntriesSchema, type AssessmentEntry } from './assessment-entry-state.ts';
import { automationHash } from './automation-hash.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

const schema = Type.Object(
  { scope: Type.String(), entries: assessmentEntriesSchema },
  { additionalProperties: false },
);
export interface AssessmentEntryBinding {
  runtime: 'codex' | 'openclaw';
  agentId: string;
  workspace: string;
  namespace: string;
  session: string;
  incarnation: string;
}

/** assessment custody uses existing private-file and lease primitives, never an intake event. */
export default class AssessmentEntryStore {
  readonly scope: string;
  readonly path: string;
  private readonly file: PrivateStateFile;
  constructor(
    private readonly root: string,
    binding: AssessmentEntryBinding,
  ) {
    this.scope = automationHash(binding);
    this.path = join(root, `github-assessment-${this.scope}.json`);
    this.file = new PrivateStateFile({
      currentUid: process.getuid?.(),
      directories: [root],
      label: 'direct assessments',
      maximumBytes: 8 * 1024 * 1024,
      path: this.path,
    });
  }
  async exclusive<T>(run: (entries: AssessmentEntry[], save: () => Promise<void>) => Promise<T>) {
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'direct assessments',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await withPrivateStateLock(lock, async () => {
        const contents = await this.file.read();
        const state: unknown =
          contents === undefined ? { scope: this.scope, entries: [] } : JSON.parse(contents);
        if (!Value.Check(schema, state) || state.scope !== this.scope)
          throw new Error('assessment-state-invalid');
        return run(state.entries, async () => {
          lock.assertHeld();
          if (!Value.Check(schema, state)) throw new Error('assessment-state-invalid');
          await this.file.write(JSON.stringify(state));
        });
      });
    } finally {
      await lock.release();
    }
  }
}
