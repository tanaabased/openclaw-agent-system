import type { AutomationHistoryOptions } from '../agent/automation-gateway.ts';
import automationOperation, { type AutomationCommandOptions } from './automation-output.ts';

export default async function automationRuns(
  options: AutomationCommandOptions,
  id: string,
  history: AutomationHistoryOptions,
) {
  await automationOperation(options, (manifest, workspace) =>
    options.automations.runs(manifest, workspace, id, history),
  );
}
