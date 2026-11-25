import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import nodeErrorCode from '../utils/node-error-code.ts';
import type { BoundStorage } from './storage/storage-lifecycle.ts';
import managedGroupName from '../utils/managed-group-name.ts';
import { automationHash } from './automation-hash.ts';
import codexSidebarPlacement, {
  sidebarSections,
  type SidebarAction,
} from './codex-sidebar-placement.ts';

const maximumBytes = 1024 * 1024;
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
export type SidebarState = Static<typeof stateSchema>;
export const sidebarReceiptSchema = Type.Object(
  { digest: text, sectionId: text },
  { additionalProperties: false },
);
export type SidebarReceipt = Static<typeof sidebarReceiptSchema>;
export interface SidebarChange {
  value?: SidebarState;
  result: SidebarEffect | { error: unknown };
}
export type SidebarEffect =
  | { status: 'done'; sectionId: string }
  | { status: 'incomplete'; code: string; instruction: string }
  | { status: 'native-action'; digest: string; request: SidebarAction; instruction: string };

/** one profile/name intent spans workspaces; uncertain native creation is never replayed. */
export default class CodexSidebarJournal {
  readonly scope: string;
  readonly name: string;
  constructor(
    profile: string,
    name: string,
    private readonly storage: BoundStorage['installation'],
  ) {
    this.name = managedGroupName(name);
    this.scope = automationHash({ profile, host: 'local', name: this.name });
  }
  private async readSaved(): Promise<unknown> {
    const rows = await this.storage
      .read({ sidebarPlacements: { scope: this.scope } })
      .catch((error: unknown) => {
        if (nodeErrorCode(error) !== 'ENOENT') throw error;
        return { sidebarPlacements: [] };
      });
    return rows.sidebarPlacements[0]?.value;
  }
  private decode(saved: unknown): SidebarState {
    const state = saved === undefined ? { version: 1, name: this.name } : saved;
    if (!Value.Check(stateSchema, state) || state.name !== this.name)
      throw new Error('automation-sidebar-state-invalid');
    return state;
  }
  async read(): Promise<SidebarState> {
    return this.decode(await this.readSaved());
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
    // A returned create receipt must survive even an unusable inventory on the same call.
    const change = (saved: unknown): SidebarChange => {
      const state = this.decode(saved);
      let value: SidebarState | undefined;
      const save = () => {
        if (Buffer.byteLength(JSON.stringify(state)) > maximumBytes)
          throw new Error('The Codex sidebar placement exceeds its size limit.');
        value = structuredClone(state);
      };
      try {
        const result = this.advance(state, save, owner, inventory, threadId, receipt);
        return { result, value };
      } catch (error) {
        if (!value) throw error;
        return { result: { error }, value };
      }
    };
    const result = await this.storage.changeSidebarPlacement(this.scope, change);
    if ('error' in result) throw result.error;
    return result;
  }
  private advance(
    state: SidebarState,
    save: () => void,
    owner: string,
    inventory: unknown,
    threadId: string,
    receipt?: SidebarReceipt,
  ): SidebarEffect {
    const incomplete = (code: string): SidebarEffect => ({
      status: 'incomplete',
      code,
      instruction:
        'Refresh native list_threads and reconcile this placement with its complete inventory. Do not repeat an uncertain native action.',
    });
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
        save();
      } else if (state.pending.sectionId !== receipt.sectionId)
        throw new Error('automation-sidebar-receipt-mismatch');
    }
    const sections = sidebarSections(inventory);
    const pending = state.pending;
    if (pending) {
      // a different workspace may observe success, but cannot replay the prepared mutation.
      if (pending.kind === 'create') {
        const matches = sections.filter(
          (section) => section.name === this.name && !pending.beforeIds.includes(section.sectionId),
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
      save();
    }
    const placement = codexSidebarPlacement(inventory, threadId, this.name, state.sectionId);
    if (!placement.request) {
      state.sectionId = placement.sectionId;
      save();
      return { status: 'done', sectionId: placement.sectionId! };
    }
    if (placement.request.tool === 'create_sidebar_section') delete state.sectionId;
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
    save();
    return {
      status: 'native-action',
      digest,
      request: placement.request,
      instruction:
        'Execute this native sidebar action once, refresh list_threads, and repeat the owning reconciliation with empty input. The runtime reads the native inventory and reconciles the retained placement. Do not retry a denial or uncertain action.',
    };
  }
}
