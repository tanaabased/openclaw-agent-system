import { join } from 'node:path';

import PrivateStateFile from '../../core/private-state-file.ts';
import nodeErrorCode from '../../utils/node-error-code.ts';
import type { Ledger as CodexAutomationLedger } from '../automations/codex-automation-snapshot.ts';
import type { AutomationLedger } from '../automations/automation-store.ts';
import type { BoundStorage } from './storage-lifecycle.ts';

export type RegistrationLedger = CodexAutomationLedger | AutomationLedger;
export const maximumLedgerBytes = 1024 * 1024;

export default function automationLedgerStorage(
  runtime: 'codex' | 'openclaw',
  root: string,
  scope: string,
  agent?: BoundStorage['agent'],
) {
  const codex = runtime === 'codex';
  const path = join(root, (codex ? 'codex-automations-' : 'automations-') + scope + '.json');
  const file = new PrivateStateFile({
    path,
    directories: [root],
    currentUid: process.getuid?.(),
    label: codex ? 'Codex automation ownership' : 'automation ownership',
    maximumBytes: maximumLedgerBytes,
  });
  return {
    path,
    file,
    async read(): Promise<unknown> {
      if (!agent) {
        const contents = await file.read();
        return contents === undefined ? undefined : JSON.parse(contents);
      }
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
      if (!agent) return file.write(JSON.stringify(ledger) + (codex ? '' : '\n'));
      await agent.saveAutomationLedger(runtime, ledger, expected);
    },
  };
}
