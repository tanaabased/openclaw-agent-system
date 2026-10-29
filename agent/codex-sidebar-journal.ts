import { join } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import managedGroupName from '../utils/managed-group-name.ts';
import { automationHash } from './automation-hash.ts';
import codexSidebarPlacement, {
  sidebarSections,
  type SidebarAction,
} from './codex-sidebar-placement.ts';

const text = Type.String({ minLength: 1 });
const stateSchema = Type.Object(
  {
    version: Type.Literal(1),
    name: text,
    sectionId: Type.Optional(text),
    pending: Type.Optional(
      Type.Object(
        {
          owner: text,
          threadId: text,
          digest: text,
          kind: Type.Union([Type.Literal('create'), Type.Literal('move')]),
          beforeIds: Type.Array(text),
          sectionId: Type.Optional(text),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
type State = Static<typeof stateSchema>;
export const sidebarReceiptSchema = Type.Object(
  { digest: text, sectionId: text },
  { additionalProperties: false },
);
export type SidebarReceipt = Static<typeof sidebarReceiptSchema>;
export type SidebarEffect =
  | { status: 'done'; sectionId: string }
  | { status: 'incomplete'; code: string; instruction: string }
  | { status: 'native-action'; digest: string; request: SidebarAction; instruction: string };

/** one profile/name intent spans workspaces; uncertain native creation is never replayed. */
export default class CodexSidebarJournal {
  readonly name: string;
  readonly path: string;
  readonly file: PrivateStateFile;
  constructor(
    readonly root: string,
    profile: string,
    name: string,
  ) {
    this.name = managedGroupName(name);
    this.path = join(
      root,
      `codex-sidebar-${automationHash({ profile, host: 'local', name: this.name })}.json`,
    );
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [root],
      currentUid: process.getuid?.(),
      label: 'Codex sidebar placement',
      maximumBytes: 1024 * 1024,
    });
  }
  async read(): Promise<State> {
    const saved = await this.file.read();
    const state: unknown = saved ? JSON.parse(saved) : { version: 1, name: this.name };
    if (!Value.Check(stateSchema, state) || state.name !== this.name)
      throw new Error('automation-sidebar-state-invalid');
    return state;
  }
  async inspect(inventory: unknown, threadId: string, receipt?: SidebarReceipt) {
    const state = await this.read();
    const returnedId = state.pending?.digest === receipt?.digest ? receipt?.sectionId : undefined;
    const placement = codexSidebarPlacement(
      inventory,
      threadId,
      this.name,
      state.sectionId ?? state.pending?.sectionId ?? returnedId,
    );
    return { state, placement };
  }
  async apply(
    owner: string,
    inventory: unknown,
    threadId: string,
    receipt?: SidebarReceipt,
  ): Promise<SidebarEffect> {
    const incomplete = (code: string): SidebarEffect => ({
      status: 'incomplete',
      code,
      instruction:
        'Refresh native list_threads and reconcile this placement with its complete inventory. Do not repeat an uncertain native action.',
    });
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'Codex sidebar placement',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30000,
      retries: { factor: 1, minTimeout: 25, maxTimeout: 25, retries: 40 },
    });
    try {
      const state = await this.read();
      const save = () => this.file.write(JSON.stringify(state));
      if (receipt) {
        if (
          !state.pending ||
          state.pending.owner !== owner ||
          state.pending.digest !== receipt.digest
        )
          throw new Error('automation-sidebar-receipt-mismatch');
        if (state.pending.kind === 'create') {
          if (state.pending.sectionId && state.pending.sectionId !== receipt.sectionId)
            throw new Error('automation-sidebar-receipt-mismatch');
          state.pending.sectionId = receipt.sectionId;
          await save();
        } else if (state.pending.sectionId !== receipt.sectionId)
          throw new Error('automation-sidebar-receipt-mismatch');
      }
      const sections = sidebarSections(inventory);
      const pending = state.pending;
      if (pending) {
        // a different workspace may observe success, but cannot replay the prepared mutation.
        if (pending.kind === 'create') {
          const matches = sections.filter(
            (section) =>
              section.name === this.name && !pending.beforeIds.includes(section.sectionId),
          );
          const created = pending.sectionId
            ? matches.find((section) => section.sectionId === pending.sectionId)
            : matches.length === 1
              ? matches[0]
              : undefined;
          if (!created)
            return incomplete(
              matches.length > 1
                ? 'automation-sidebar-ambiguous'
                : 'automation-sidebar-create-unresolved',
            );
          state.sectionId = created.sectionId;
        } else {
          const placed = codexSidebarPlacement(
            inventory,
            pending.threadId,
            this.name,
            pending.sectionId,
          );
          if (placed.request || placed.sectionId !== pending.sectionId)
            return incomplete('automation-sidebar-move-unresolved');
          state.sectionId = placed.sectionId;
        }
        delete state.pending;
        await save();
      }
      const placement = codexSidebarPlacement(inventory, threadId, this.name, state.sectionId);
      if (!placement.request) {
        state.sectionId = placement.sectionId;
        await save();
        return { status: 'done', sectionId: placement.sectionId! };
      }
      if (placement.request.tool === 'create_sidebar_section' && state.sectionId)
        return incomplete('automation-sidebar-retained-section-missing');
      const intent = {
        owner,
        threadId,
        kind:
          placement.request.tool === 'create_sidebar_section'
            ? ('create' as const)
            : ('move' as const),
        beforeIds: sections.map((section) => section.sectionId),
        ...(placement.sectionId ? { sectionId: placement.sectionId } : {}),
      };
      const digest = automationHash({ ...intent, name: this.name });
      state.pending = { ...intent, digest };
      await save();
      return {
        status: 'native-action',
        digest,
        request: placement.request,
        instruction:
          'Execute this native sidebar action once. Retain its section ID with this digest, refresh list_threads, and repeat the owning reconciliation with nativeInventory and placementReceipt. Do not retry a denial or uncertain action.',
      };
    } finally {
      await lock.release();
    }
  }
}
