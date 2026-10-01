import automationOperation, { type AutomationCommandOptions } from './automation-output.ts';

export default async function automationRun(options: AutomationCommandOptions, id: string) {
  await automationOperation(options, (manifest, workspace) =>
    options.automations.run(manifest, workspace, id),
  );
}
