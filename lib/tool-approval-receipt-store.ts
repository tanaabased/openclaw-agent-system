import { createHash } from 'node:crypto';

interface ApprovalReceipt {
  agentId: string;
  expiresAt: number;
  inputHash: string;
  toolId: string;
}

export interface AgentSystemApprovalReceipt {
  agentId: string;
  input: unknown;
  toolCallId: string;
  toolId: string;
}

const maximumReceipts = 1_024;
const receiptLifetimeMs = 10 * 60 * 1_000;

export function hashAgentSystemToolInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16);
}

/** Keep bounded one-use proof that OpenClaw approved an exact Agent System tool call. */
export default class AgentSystemToolApprovalReceiptStore {
  readonly #receipts = new Map<string, ApprovalReceipt>();

  record(receipt: AgentSystemApprovalReceipt): void {
    const now = Date.now();
    this.#prune(now);
    this.#receipts.set(receipt.toolCallId, {
      agentId: receipt.agentId,
      expiresAt: now + receiptLifetimeMs,
      inputHash: hashAgentSystemToolInput(receipt.input),
      toolId: receipt.toolId,
    });
    while (this.#receipts.size > maximumReceipts) {
      const oldest = this.#receipts.keys().next().value;
      if (!oldest) break;
      this.#receipts.delete(oldest);
    }
  }

  consume(receipt: AgentSystemApprovalReceipt): boolean {
    const now = Date.now();
    this.#prune(now);
    const stored = this.#receipts.get(receipt.toolCallId);
    this.#receipts.delete(receipt.toolCallId);
    return Boolean(
      stored &&
      stored.expiresAt > now &&
      stored.agentId === receipt.agentId &&
      stored.toolId === receipt.toolId &&
      stored.inputHash === hashAgentSystemToolInput(receipt.input),
    );
  }

  #prune(now: number): void {
    for (const [toolCallId, receipt] of this.#receipts) {
      if (receipt.expiresAt <= now) this.#receipts.delete(toolCallId);
    }
  }
}
