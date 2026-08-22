import { isAbsolute, join, resolve } from 'node:path';

import { githubNotificationChannelId, type NotificationRoutingReceipt } from './routing.ts';
import PrivateStateFile from '../state/private-state-file.ts';

const maximumReceiptBytes = 16 * 1024;
const receiptKeys = new Set(['accountId', 'agentId', 'channelId', 'schemaVersion', 'workspaceDir']);

export interface NotificationRoutingReceiptStoreDependencies {
  currentUid?: number;
  rootDir?: string;
}

function validAgentId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function isReceipt(value: unknown): value is NotificationRoutingReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<NotificationRoutingReceipt>;
  return (
    Object.keys(value).every((key) => receiptKeys.has(key)) &&
    candidate.schemaVersion === 1 &&
    candidate.channelId === githubNotificationChannelId &&
    validAgentId(candidate.accountId) &&
    validAgentId(candidate.agentId) &&
    candidate.accountId === candidate.agentId &&
    typeof candidate.workspaceDir === 'string' &&
    isAbsolute(candidate.workspaceDir) &&
    resolve(candidate.workspaceDir) === candidate.workspaceDir &&
    !candidate.workspaceDir.includes('\0')
  );
}

/** Persist private proof of the exact global notification route Agent System owns. */
export default class NotificationRoutingReceiptStore {
  readonly #currentUid: number | undefined;
  readonly #rootDir: string | undefined;

  constructor(dependencies: NotificationRoutingReceiptStoreDependencies) {
    this.#currentUid = dependencies.currentUid;
    this.#rootDir = dependencies.rootDir ? resolve(dependencies.rootDir) : undefined;
  }

  async read(agentId: string): Promise<NotificationRoutingReceipt | undefined> {
    const file = this.#file(agentId);
    if (!file) return undefined;
    const contents = await file.read();
    if (contents === undefined) return undefined;
    try {
      const value = JSON.parse(contents) as unknown;
      if (isReceipt(value) && value.agentId === agentId) return value;
    } catch (error) {
      throw new Error('The notification routing receipt is invalid.', { cause: error });
    }
    throw new Error('The notification routing receipt is invalid.');
  }

  async write(receipt: NotificationRoutingReceipt): Promise<void> {
    if (!isReceipt(receipt)) throw new Error('The notification routing receipt is invalid.');
    const file = this.#file(receipt.agentId);
    if (!file) throw new Error('The notification routing receipt store is unavailable.');
    await file.write(`${JSON.stringify(receipt, undefined, 2)}\n`);
  }

  async remove(agentId: string): Promise<boolean> {
    return (await this.#file(agentId)?.remove()) ?? false;
  }

  #file(agentId: string): PrivateStateFile | undefined {
    if (!this.#rootDir || !validAgentId(agentId)) return undefined;
    const agentDir = join(this.#rootDir, agentId);
    return new PrivateStateFile({
      currentUid: this.#currentUid,
      directories: [this.#rootDir, agentDir],
      label: 'notification routing receipt',
      maximumBytes: maximumReceiptBytes,
      path: join(agentDir, 'notification-routing.json'),
    });
  }
}
