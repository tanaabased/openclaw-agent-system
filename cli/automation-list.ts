import automationOperation, { type AutomationCommandOptions } from './automation-output.ts';

export default async function automationList(options: AutomationCommandOptions) {
  await automationOperation(options, (manifest, workspace) =>
    options.automations.list(manifest, workspace),
  );
}
