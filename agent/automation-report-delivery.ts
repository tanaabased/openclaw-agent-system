import automationReport, { type AutomationReportInput } from './automation-report.ts';
import automationThreadGateway from './automation-thread-gateway.ts';
import { nativeObject } from './automation-gateway.ts';
import type SessionDispatchCredential from '../credentials/session-dispatch.ts';

// a separate bounded delivery allowance must survive the command's own timeout.
export const automationReportTimeoutMs = 30_000;

export interface AutomationReportTarget {
  sessionKey: string;
  agentId: string;
  workspaceDir: string;
  scope: string;
}

export interface AutomationReportDelivery {
  status: 'delivered' | 'not-delivered' | 'uncertain';
  executionId: string;
  messageId?: string;
  code?: string;
}

/** one attempt only: a lost acknowledgement must never replay the command or append. */
export default async function deliverAutomationReport(options: {
  target: AutomationReportTarget;
  input: AutomationReportInput;
  credential: Pick<SessionDispatchCredential, 'use'>;
  assertCurrent(): Promise<void>;
}): Promise<AutomationReportDelivery> {
  const executionId = options.input.executionId;
  let attempted = false;
  try {
    await options.assertCurrent();
    return await options.credential.use(
      {
        signal: AbortSignal.timeout(automationReportTimeoutMs),
        assertCurrent: options.assertCurrent,
      },
      async (request) => {
        const adapter = automationThreadGateway(async (method, params) => {
          const response = await request(method, params);
          if (!nativeObject(response)) throw new Error('automation-report-response-invalid');
          return response;
        }, options.target);
        const thread = await adapter.lookup(options.target.sessionKey);
        if (!thread || thread.archived || thread.id !== options.target.sessionKey)
          throw new Error('automation-report-target-unavailable');
        await options.assertCurrent();
        const message = automationReport(options.input);
        attempted = true;
        const response = await request('chat.inject', {
          sessionKey: thread.id,
          agentId: options.target.agentId,
          message,
          label: 'Automation report',
        });
        if (
          !nativeObject(response) ||
          response.ok !== true ||
          typeof response.messageId !== 'string' ||
          !response.messageId.trim()
        )
          throw new Error('automation-report-receipt-invalid');
        return { status: 'delivered', executionId, messageId: response.messageId };
      },
    );
  } catch {
    return {
      status: attempted ? 'uncertain' : 'not-delivered',
      executionId,
      code: attempted ? 'automation-report-delivery-uncertain' : 'automation-report-unavailable',
    };
  }
}
