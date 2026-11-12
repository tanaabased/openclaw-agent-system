import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// another installation's damaged payload must not block this installed planning journey.
const [pluginData, workspace, otherHome] = process.argv.slice(2);
const binding = { workspace: resolve(workspace), codexHome: resolve(otherHome), agentId: 'other' };
const scope = createHash('sha256')
  .update(
    JSON.stringify({
      agentId: binding.agentId,
      profile: binding.codexHome,
      runtime: 'codex',
      workspaceDir: binding.workspace,
    }),
  )
  .digest('hex');
await writeFile(
  join(pluginData, `codex-automations-${scope}.json`),
  JSON.stringify({ version: 1, scope, binding, records: 'damaged', pending: { broken: true } }),
  { mode: 0o600 },
);
