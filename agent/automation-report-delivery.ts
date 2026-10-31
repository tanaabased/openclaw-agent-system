import { validateChatSendParams } from '@openclaw/gateway-protocol';

import automationReport, {
  automationReportCardValid,
  prepareAutomationReport,
  type AutomationReportInput,
} from './automation-report.ts';
import type AutomationReportStore from './automation-report-store.ts';
import type { AutomationReportRecord } from './automation-report-store.ts';
import automationThreadGateway from './automation-thread-gateway.ts';
import { AutomationError, nativeObject } from './automation-gateway.ts';
import openClawTurnReply from './openclaw-turn-evidence.ts';
import gatewayErrorDiagnostic from '../utils/gateway-error-diagnostic.ts';
import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import type { DispatchRequest } from '../credentials/session-dispatch.ts';

// bound one observation pass, not the model's execution lifetime.
export const automationReportTimeoutMs = 30_000;

export interface AutomationReportTarget {
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
  scope: string;
  model?: string;
  effort?: string;
}

export interface AutomationReportDelivery {
  status: 'delivered' | 'not-delivered' | 'pending' | 'failed' | 'uncertain';
  executionId: string;
  messageId?: string;
  code?: string;
}

export function automationReportDelivery(record: AutomationReportRecord): AutomationReportDelivery {
  return {
    status:
      record.state === 'delivered'
        ? 'delivered'
        : record.state === 'failed'
          ? 'failed'
          : record.state === 'uncertain' || record.state === 'sending'
            ? 'uncertain'
            : 'pending',
    executionId: record.executionId,
    ...(record.messageId ? { messageId: record.messageId } : {}),
    ...(record.code ? { code: record.code } : {}),
  };
}

/** reconcile the original native identity; an ambiguous submission is never replayed. */
export async function reconcileAutomationReport(options: {
  store: AutomationReportStore;
  executionId: string;
  credential: Pick<SessionDispatchCredential, 'use'>;
  assertCurrent(record: AutomationReportRecord): Promise<void>;
  selectSettings(record: AutomationReportRecord, request: DispatchRequest): Promise<void>;
}): Promise<AutomationReportDelivery> {
  const { store, executionId } = options;
  let record = await store.read(executionId);
  if (!record) throw new Error('automation-report-record-missing');
  if (record.state === 'delivered' || record.state === 'failed') {
    // Move pre-partition records out of active recovery without replaying the report.
    await store.update(executionId, () => undefined);
    return automationReportDelivery(record);
  }
  let sending = false;
  let claimed = false;
  let attempted = false;
  try {
    await options.assertCurrent(record);
    await options.credential.use(
      {
        signal: AbortSignal.timeout(automationReportTimeoutMs),
        assertCurrent: () => options.assertCurrent(record!),
      },
      async (request) => {
        const adapter = automationThreadGateway(async (method, params) => {
          const response = await request(method, params);
          if (!nativeObject(response)) throw new Error('automation-report-response-invalid');
          return response;
        }, record!.target);
        let thread = await adapter.lookup(record!.target.sessionKey);
        if (
          !thread ||
          !thread.incarnation ||
          thread.archived ||
          thread.id !== record!.target.sessionKey ||
          (record!.target.sessionId && thread.incarnation !== record!.target.sessionId)
        )
          throw new Error('automation-report-target-unavailable');
        const sessionId = thread.incarnation;
        const sessionKey = thread.id;
        await options.assertCurrent(record!);
        // claim settings selection and send together; recovery never selects for an admitted run.
        record = await store.update(executionId, (current) => {
          if (current.state !== 'pending') return;
          current.target.sessionId = sessionId;
          current.state = 'sending';
          delete current.code;
          claimed = true;
        });
        if (claimed) {
          await options.selectSettings(record!, request);
          const selected = await adapter.lookup(sessionKey);
          if (!selected || selected.archived || selected.incarnation !== sessionId)
            throw new Error('automation-report-target-unavailable');
          thread = selected;
          if (
            (record!.target.model && thread.model !== record!.target.model) ||
            (record!.target.effort && thread.effort !== record!.target.effort)
          )
            throw new Error('automation-report-settings-drift');
        }
        if (claimed) {
          const params = {
            sessionKey,
            sessionId,
            agentId: record.target.agentId,
            message: automationReport(record.input),
            idempotencyKey: executionId,
            queueMode: 'followup',
            deliver: false,
            ...(record.target.effort ? { thinking: record.target.effort } : {}),
          };
          if (!validateChatSendParams(params)) throw new Error('automation-report-request-invalid');
          await options.assertCurrent(record);
          attempted = true;
          sending = true;
          const accepted = await request('chat.send', params);
          if (
            !nativeObject(accepted) ||
            accepted.runId !== executionId ||
            !['started', 'queued', 'ok'].includes(String(accepted.status))
          )
            throw new Error('automation-report-receipt-invalid');
          record = await store.update(executionId, (current) => {
            if (current.state === 'sending' || current.state === 'uncertain')
              current.state = 'submitted';
          });
          sending = false;
        }
        // admission is not delivery. exact native terminal metadata survives a gateway restart.
        const reply = await openClawTurnReply(request, { sessionKey, sessionId }, executionId);
        if (reply) {
          const body = (reply.content as Array<{ type: string; text?: string }>)
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('\n');
          record = await store.update(executionId, (current) => {
            if (!current.guarded) {
              current.state = 'failed';
              current.code = 'automation-report-hooks-not-observed';
              return;
            }
            if (
              (current.target.model && current.effective?.model !== current.target.model) ||
              (current.target.effort && current.effective?.effort !== current.target.effort)
            ) {
              current.state = 'failed';
              current.code = 'automation-report-settings-mismatch';
              return;
            }
            if (!automationReportCardValid(body, current.input)) {
              current.state = 'failed';
              current.code = 'automation-report-card-invalid';
              return;
            }
            current.state = 'delivered';
            current.messageId = String((reply.__openclaw as { id: string }).id);
            delete current.code;
          });
        } else {
          const observed = await request('agent.wait', { runId: executionId, timeoutMs: 0 });
          if (
            nativeObject(observed) &&
            observed.runId === executionId &&
            observed.status === 'error'
          )
            record = await store.update(executionId, (current) => {
              current.state = 'failed';
              current.code = 'automation-report-model-failed';
            });
        }
      },
    );
  } catch (error) {
    const diagnostic = gatewayErrorDiagnostic(error);
    record = await store.update(executionId, (current) => {
      // a concurrent terminal hook may already have settled this occurrence.
      if (current.state === 'delivered' || current.state === 'failed') return;
      if (claimed && !attempted && error instanceof AutomationError) {
        current.state = 'failed';
        current.code =
          error.code === 'automation-model-unavailable'
            ? 'automation-report-model-unavailable'
            : error.code.replace(/^automation-thread-/, 'automation-report-');
        return;
      }
      if (claimed && !attempted) current.state = 'pending';
      if (sending) {
        current.state =
          diagnostic.category === 'rejected' || diagnostic.requestDispatched === false
            ? 'pending'
            : 'uncertain';
      }
      current.code =
        error instanceof Error && /^automation-report-[a-z-]+$/.test(error.message)
          ? error.message
          : diagnostic.category === 'rejected'
            ? 'automation-report-rejected'
            : 'automation-report-unavailable';
    });
  }
  return automationReportDelivery(record);
}

/** retain captured evidence before the first request; reporting never changes command status. */
export default async function deliverAutomationReport(options: {
  target: AutomationReportTarget;
  input: AutomationReportInput;
  store: AutomationReportStore;
  hash: string;
  manifestDigest: string;
  credential?: Pick<SessionDispatchCredential, 'use'>;
  assertCurrent(record: AutomationReportRecord): Promise<void>;
  selectSettings(record: AutomationReportRecord, request: DispatchRequest): Promise<void>;
}): Promise<AutomationReportDelivery> {
  const executionId = options.input.executionId;
  const retained = await options.store.withLock(executionId, async () => {
    if (await options.store.read(executionId)) return true;
    // An expired capture cannot recreate a pruned terminal occurrence and resend its report.
    if (options.store.expired(options.input.startedAt)) return false;
    await options.store.write({
      version: 1,
      executionId,
      hash: options.hash,
      manifestDigest: options.manifestDigest,
      target: options.target,
      input: prepareAutomationReport(options.input),
      state: 'pending',
    });
    return true;
  });
  if (!retained) return { status: 'failed', executionId, code: 'automation-report-expired' };
  if (!options.credential)
    return { status: 'pending', executionId, code: 'automation-report-unavailable' };
  return reconcileAutomationReport({ ...options, credential: options.credential, executionId });
}
