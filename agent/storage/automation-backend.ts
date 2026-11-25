import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import withWorkflowLock from './workflow-lock.ts';

import nodeErrorCode from '../../utils/node-error-code.ts';
import type { Ledger as CodexAutomationLedger } from '../automations/codex-automation-snapshot.ts';
import type { AutomationLedger } from '../automations/automation-store.ts';
import type { BoundStorage } from './storage-lifecycle.ts';

export type RegistrationLedger = CodexAutomationLedger | AutomationLedger;
export const maximumLedgerBytes = 1024 * 1024;

export default function automationLedgerStorage(
  runtime: 'codex' | 'openclaw',
  scope: string,
  agent: BoundStorage['agent'],
) {
  return {
    async read(): Promise<unknown> {
      const rows = await agent
        .read({ automationState: { scope }, automationRegistrations: { scope } })
        .catch((error: unknown) => {
          // Doctor can inspect a fresh workspace before Install creates its database.
          if (nodeErrorCode(error) !== 'ENOENT') throw error;
          return undefined;
        });
      if (!rows) return undefined;
      const header = rows.automationState[0];
      const records = rows.automationRegistrations;
      if (!header && !records.length) return undefined;
      if (header?.value?.scope !== scope || records.some(({ id, value }) => value?.id !== id))
        throw new Error('automation-ownership-invalid');
      return { ...header.value, records: records.map(({ value }) => value) };
    },
    async write(ledger: RegistrationLedger, expected: RegistrationLedger) {
      await agent.saveAutomationLedger(runtime, ledger, expected);
    },
  };
}

const registrationThread = new AsyncLocalStorage<string>();

function lockThreads<T>(path: string, run: () => Promise<T>) {
  return withWorkflowLock(path, 'Automation conversations', run, {
    retries: { factor: 1, minTimeout: 25, maxTimeout: 25, retries: 40 },
  });
}

// A registration selecting a native thread holds its binding stable through the handoff.
export function withRegistrationThread<T>(
  agent: BoundStorage['agent'],
  scope: string,
  run: () => Promise<T>,
) {
  const path = agent.workflowLockPath('automation-threads', scope);
  return lockThreads(path, () => registrationThread.run(resolve(path), run));
}

export function withAutomationThreadLock<T>(path: string, run: () => Promise<T>) {
  if (registrationThread.getStore() === resolve(path)) return registrationThread.exit(run);
  return lockThreads(path, run);
}
