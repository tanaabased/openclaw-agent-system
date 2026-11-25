import withWorkflowLock from '../storage/workflow-lock.ts';
import type { SessionStorage } from '../storage/storage-lifecycle.ts';
import type { entriesSchema } from './retirement/native-retirement.ts';
import type { implementationEntriesSchema } from './implementation/implementation-entry-state.ts';
import { join } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import PrivateStateFile from '../../core/private-state-file.ts';
import { automationHash } from '../automation-hash.ts';

const maximumEntryBytes = 8 * 1024 * 1024;

export interface DirectEntryBinding {
  runtime: 'codex' | 'openclaw';
  agentId: string;
  workspace: string;
  namespace: string;
  session: string;
  incarnation: string;
}

/** Serialize direct operations for the same native conversation and entry kind. */
export class DirectEntryStore<S extends typeof implementationEntriesSchema | typeof entriesSchema> {
  readonly scope: string;
  readonly path: string;
  private readonly file: PrivateStateFile;
  private readonly schema;
  constructor(
    root: string,
    binding: DirectEntryBinding,
    entriesSchema: S,
    private readonly kind: 'implementation' | 'native-retirement',
    private readonly storage?: SessionStorage,
  ) {
    this.schema = Type.Unsafe<{ scope: string; entries: Static<S> }>(
      Type.Object(
        { scope: Type.String(), entries: entriesSchema },
        { additionalProperties: false },
      ),
    );
    this.scope = automationHash(binding);
    this.path = join(root, `github-${kind}-${this.scope}.json`);
    this.file = new PrivateStateFile({
      currentUid: process.getuid?.(),
      directories: [root],
      label: `direct ${this.kind} entries`,
      maximumBytes: maximumEntryBytes,
      path: this.path,
    });
  }
  private async readState(): Promise<unknown> {
    if (this.storage)
      return {
        scope: this.scope,
        entries: await this.storage.readDirectEntries(this.scope, this.kind),
      };
    const contents = await this.file.read();
    return contents === undefined ? { scope: this.scope, entries: [] } : JSON.parse(contents);
  }
  private async validated() {
    const state = await this.readState();
    if (!Value.Check(this.schema, state) || state.scope !== this.scope)
      throw new Error(`${this.kind}-state-invalid`);
    return state;
  }
  async inspect() {
    if (this.storage) return (await this.validated()).entries;
    return this.exclusive(async (entries) => entries);
  }
  async exclusive<T>(
    run: (entries: Static<S>, save: (removeEmpty?: boolean) => Promise<void>) => Promise<T>,
  ) {
    const edit = async () => {
      const state = await this.validated();
      let expected = this.storage ? structuredClone(state.entries) : [];
      return run(state.entries, async (removeEmpty = false) => {
        if (!Value.Check(this.schema, state)) throw new Error(`${this.kind}-state-invalid`);
        if (this.storage) {
          if (Buffer.byteLength(JSON.stringify(state)) > maximumEntryBytes)
            throw new Error(`The direct ${this.kind} entries exceeds its size limit.`);
          await this.storage.saveDirectEntries(this.scope, this.kind, state.entries, expected);
          expected = structuredClone(state.entries);
        } else if (removeEmpty && Array.isArray(state.entries) && state.entries.length === 0)
          await this.file.remove();
        else await this.file.write(JSON.stringify(state));
      });
    };
    if (this.storage && this.kind === 'native-retirement') return edit();
    return withWorkflowLock(this.path, `direct ${this.kind} entries`, edit);
  }
}
