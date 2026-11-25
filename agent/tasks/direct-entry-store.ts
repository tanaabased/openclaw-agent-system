import withWorkflowLock from '../storage/workflow-lock.ts';
import type { SessionStorage } from '../storage/storage-lifecycle.ts';
import type { entriesSchema } from './retirement/native-retirement.ts';
import type { implementationEntriesSchema } from './implementation/implementation-entry-state.ts';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
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
  private readonly schema;
  constructor(
    binding: DirectEntryBinding,
    entriesSchema: S,
    private readonly kind: 'implementation' | 'native-retirement',
    private readonly storage: SessionStorage,
  ) {
    this.schema = Type.Unsafe<{ scope: string; entries: Static<S> }>(
      Type.Object(
        { scope: Type.String(), entries: entriesSchema },
        { additionalProperties: false },
      ),
    );
    this.scope = automationHash(binding);
  }
  private async validated() {
    const state = {
      scope: this.scope,
      entries: await this.storage.readDirectEntries(this.scope, this.kind),
    };
    if (!Value.Check(this.schema, state) || state.scope !== this.scope)
      throw new Error(`${this.kind}-state-invalid`);
    return state;
  }
  async inspect() {
    return (await this.validated()).entries;
  }
  async exclusive<T>(run: (entries: Static<S>, save: () => Promise<void>) => Promise<T>) {
    const edit = async () => {
      const state = await this.validated();
      let expected = structuredClone(state.entries);
      return run(state.entries, async () => {
        if (!Value.Check(this.schema, state)) throw new Error(`${this.kind}-state-invalid`);
        if (Buffer.byteLength(JSON.stringify(state)) > maximumEntryBytes)
          throw new Error(`The direct ${this.kind} entries exceeds its size limit.`);
        await this.storage.saveDirectEntries(this.scope, this.kind, state.entries, expected);
        expected = structuredClone(state.entries);
      });
    };
    if (this.kind === 'native-retirement') return edit();
    const path = this.storage.workflowLockPath('implementation', this.scope);
    return withWorkflowLock(path, `direct ${this.kind} entries`, edit);
  }
}
