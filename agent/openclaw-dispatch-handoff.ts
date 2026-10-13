import { automationHash } from './automation-hash.ts';
import type OpenClawDispatchStore from './openclaw-dispatch-state.ts';
import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';

export interface DispatchCaller {
  sessionKey: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
}
export interface DispatchSession {
  sessionKey: string;
  sessionId: string;
  parentSessionKey: string;
  parentSessionId: string;
  cwd: string;
  model: string;
  effort?: string;
}
export interface DispatchHandoffHost {
  read(sessionKey: string): Promise<DispatchSession>;
  validate(record: OpenClawDispatchRecord): Promise<void>;
}

function selection(record: OpenClawDispatchRecord) {
  const routing: unknown = JSON.parse(record.routing ?? 'null');
  if (!routing || typeof routing !== 'object' || !('candidate' in routing))
    throw new Error('dispatch-routing-unresolved');
  const candidate = routing.candidate;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    !('status' in candidate) ||
    candidate.status !== 'mapped' ||
    !('model' in candidate) ||
    typeof candidate.model !== 'string' ||
    !('thinking' in candidate) ||
    typeof candidate.thinking !== 'string' ||
    candidate.model !== record.request?.model
  )
    throw new Error('dispatch-routing-unresolved');
  return { model: candidate.model, effort: candidate.thinking };
}

/** Native receipts, never a model-supplied receipt, advance this runtime adapter. */
export default class OpenClawDispatchHandoff {
  constructor(
    readonly store: OpenClawDispatchStore,
    readonly host: DispatchHandoffHost,
  ) {}

  private async session(record: OpenClawDispatchRecord) {
    if (!record.native || !record.creationCall || !record.request)
      throw new Error('dispatch-native-receipt-missing');
    const native = await this.host.read(record.native.sessionKey);
    if (
      native.sessionId !== record.native.sessionId ||
      native.sessionKey !== record.threadId ||
      native.parentSessionKey !== record.sourceThreadId ||
      native.parentSessionId !== record.creationCall.sessionId ||
      native.cwd !== record.worktree
    )
      throw new Error('dispatch-native-session-diverged');
    return native;
  }

  /** Persist consumption before allowing the native tool to perform its effect. */
  async claimCreation(id: string, caller: DispatchCaller, request: unknown) {
    return this.store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (
        !record?.request ||
        record.phase !== 'creating' ||
        record.retired ||
        record.sourceThreadId !== caller.sessionKey ||
        record.creationCall ||
        automationHash(record.request) !== automationHash(request)
      )
        throw new Error('dispatch-creation-not-authorized');
      await this.host.validate(record);
      record.creationCall = {
        sessionId: caller.sessionId,
        runId: caller.runId,
        toolCallId: caller.toolCallId,
      };
      await save();
    });
  }

  /** Called only by the trusted after-tool hook for the exact claimed native call. */
  async observeCreation(
    id: string,
    caller: DispatchCaller,
    receipt: {
      sessionKey: string;
      runId: string;
    },
  ) {
    return this.store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (
        !record?.creationCall ||
        record.sourceThreadId !== caller.sessionKey ||
        automationHash(record.creationCall) !==
          automationHash({
            sessionId: caller.sessionId,
            runId: caller.runId,
            toolCallId: caller.toolCallId,
          })
      )
        throw new Error('dispatch-native-creation-source-mismatch');
      const native = await this.host.read(receipt.sessionKey);
      if (
        native.sessionKey !== receipt.sessionKey ||
        native.parentSessionKey !== caller.sessionKey ||
        native.parentSessionId !== caller.sessionId ||
        native.cwd !== record.worktree ||
        state.records.some(
          (other) =>
            other.id !== id &&
            (other.threadId === receipt.sessionKey || other.native?.sessionId === native.sessionId),
        )
      )
        throw new Error('dispatch-native-receipt-invalid');
      const observed = {
        sessionKey: receipt.sessionKey,
        sessionId: native.sessionId,
        runId: receipt.runId,
        sourceSessionId: caller.sessionId,
        toolCallId: caller.toolCallId,
      };
      if (record.native && automationHash(record.native) !== automationHash(observed))
        throw new Error('dispatch-native-receipt-conflict');
      record.native = observed;
      record.threadId = observed.sessionKey;
      const setup = record.setupObservation;
      if (
        setup &&
        setup.sessionKey === observed.sessionKey &&
        setup.sessionId === observed.sessionId &&
        setup.runId === observed.runId
      )
        record.setupComplete = setup.success;
      await save();
    }, true);
  }

  async observeSetupEnd(id: string, caller: Omit<DispatchCaller, 'toolCallId'>, success: boolean) {
    return this.store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (
        !record?.creationCall ||
        (record.native &&
          (record.native.sessionKey !== caller.sessionKey ||
            record.native.sessionId !== caller.sessionId ||
            record.native.runId !== caller.runId))
      )
        throw new Error('dispatch-setup-turn-mismatch');
      const native = await this.host.read(caller.sessionKey);
      if (
        native.sessionId !== caller.sessionId ||
        native.parentSessionKey !== record.sourceThreadId ||
        native.parentSessionId !== record.creationCall.sessionId ||
        native.cwd !== record.worktree
      )
        throw new Error('dispatch-setup-turn-mismatch');
      const observed = {
        sessionKey: caller.sessionKey,
        sessionId: caller.sessionId,
        runId: caller.runId,
        success,
      };
      if (
        record.setupObservation &&
        automationHash(record.setupObservation) !== automationHash(observed)
      )
        throw new Error('dispatch-setup-observation-conflict');
      record.setupObservation = observed;
      if (record.native) record.setupComplete = success;
      if (!success) record.blocker = 'dispatch-setup-turn-failed';
      await save();
    }, true);
  }

  /** Read back a native settings change; never confuse requested settings with execution. */
  async reconcile(id: string, sourceSessionKey: string, now: number) {
    return this.store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (!record?.request || record.sourceThreadId !== sourceSessionKey || record.retired)
        throw new Error('dispatch-intake-caller-required');
      await this.host.validate(record);
      const native = await this.session(record);
      if (!record.setupComplete) return { status: 'setup-pending' as const, id };
      const selected = selection(record);
      if (native.model !== selected.model || native.effort !== selected.effort) {
        if (record.continuation) throw new Error('dispatch-native-settings-diverged');
        return {
          status: 'settings-required' as const,
          id,
          request: {
            action: 'patch',
            sessionKey: native.sessionKey,
            model: selected.model,
            thinkingLevel: selected.effort,
          },
        };
      }
      record.effective = { status: 'verified', ...selected };
      if (record.continuation) {
        await save();
        return {
          status: record.execution ? ('assessing' as const) : ('continuation-pending' as const),
          id,
        };
      }
      record.continuation = {
        message: `Begin assessment only. Call agent_system_dispatch with action context and id ${id} before investigation. Use its verified evidence, selected skill, saved model and effort, and result contract. No implementation or publication.`,
        issuedAt: now,
      };
      await save();
      return {
        status: 'continuation-required' as const,
        id,
        request: {
          sessionKey: native.sessionKey,
          message: record.continuation.message,
          mode: 'followup',
          timeoutSeconds: 0,
        },
      };
    });
  }

  async claimContinuation(id: string, caller: DispatchCaller, request: unknown) {
    return this.store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (
        !record?.continuation ||
        record.continuation.toolCallId ||
        record.sourceThreadId !== caller.sessionKey ||
        !record.setupComplete ||
        record.creationCall?.sessionId !== caller.sessionId ||
        automationHash(request) !==
          automationHash({
            sessionKey: record.threadId,
            message: record.continuation.message,
            mode: 'followup',
            timeoutSeconds: 0,
          })
      )
        throw new Error('dispatch-continuation-not-authorized');
      await this.host.validate(record);
      const native = await this.session(record);
      const selected = selection(record);
      if (native.model !== selected.model || native.effort !== selected.effort)
        throw new Error('dispatch-native-settings-diverged');
      record.continuation.toolCallId = caller.toolCallId;
      await save();
    });
  }

  async observeContinuation(id: string, caller: DispatchCaller, runId: string) {
    return this.store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (
        !record?.continuation ||
        record.sourceThreadId !== caller.sessionKey ||
        record.creationCall?.sessionId !== caller.sessionId ||
        record.continuation.toolCallId !== caller.toolCallId ||
        runId === record.native?.runId ||
        (record.continuation.runId && record.continuation.runId !== runId)
      )
        throw new Error('dispatch-continuation-source-mismatch');
      record.continuation.runId = runId;
      await save();
    }, true);
  }

  /** Tool context supplies the actual model; the initial setup turn can never assess. */
  async verifyExecution(id: string, caller: DispatchCaller, actualModel: string) {
    return this.store.exclusive(async (state, save) => {
      const record = state.records.find((entry) => entry.id === id);
      if (
        !record?.native ||
        !record.setupComplete ||
        !record.continuation?.runId ||
        caller.sessionKey !== record.native.sessionKey ||
        caller.sessionId !== record.native.sessionId ||
        caller.runId === record.native.runId ||
        (!record.execution && caller.runId !== record.continuation.runId)
      )
        throw new Error('dispatch-assessment-caller-mismatch');
      await this.host.validate(record);
      const native = await this.session(record);
      const selected = selection(record);
      if (
        actualModel !== selected.model ||
        native.model !== selected.model ||
        native.effort !== selected.effort
      )
        throw new Error('dispatch-native-execution-diverged');
      record.execution = { runId: caller.runId, ...selected };
      if (record.phase !== 'complete') record.phase = 'assessing';
      await save();
      return structuredClone(record);
    }, true);
  }
}
