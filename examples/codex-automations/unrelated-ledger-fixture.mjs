import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';

// another installation's damaged payload must not block this installed planning journey.
const [pluginData, workspace, otherHome] = process.argv.slice(2);
const binding = {
  workspace: resolve(workspace),
  codexHome: resolve(otherHome),
  agentId: 'codex-automation-example',
};
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
const db = new DatabaseSync(join(pluginData, 'agent-system-storage', binding.agentId + '.sqlite'));
db.prepare('INSERT INTO automation_state (scope, value) VALUES (?, ?)').run(
  scope,
  JSON.stringify({ version: 1, scope, binding, pending: { broken: true } }),
);
db.close();
