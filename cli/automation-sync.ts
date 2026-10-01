import automationOperation, { type AutomationCommandOptions } from './automation-output.ts';

export default async function automationSync(options: AutomationCommandOptions) {
  await automationOperation(options, (manifest, workspace) =>
    options.automations
      .reconcile(manifest, workspace)
      .then((result) => ({ runtime: 'openclaw', status: 'synchronized', ...result })),
  );
}
