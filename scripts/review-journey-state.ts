import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { listAgentStores } from '../agent/storage/backend.ts';
import { parseStorageConfig } from '../manifest/storage-schema.ts';
import { resolveFileCredentialStoreRoot } from '../credentials/file-store.ts';

const stateRoot = process.env.OPENCLAW_STATE_DIR;
const kind = process.argv[2];
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions only.');
assert.ok(stateRoot, 'The journey requires its isolated OpenClaw state directory.');
assert.ok(kind === 'dispatch' || kind === 'replies');

const installation = {
  agentRoot: join(stateRoot, 'agent-system-storage'),
  installationRoot: join(
    resolveFileCredentialStoreRoot(process.env) ?? stateRoot,
    'agent-system-instance',
  ),
  schemaRoot: join(import.meta.dirname, '../agent/storage'),
  // Isolate CLI startup output from the JSON records consumed by jq.
  readInstallationBackend: async () => {
    const storage = execFileSync(
      'openclaw',
      ['config', 'get', 'plugins.entries.agent-system.config.storage', '--json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
    );
    return parseStorageConfig(JSON.parse(storage));
  },
};

for await (const { agent } of listAgentStores(installation)) {
  if (kind === 'replies') {
    const { replyDrafts } = await agent.read({ replyDrafts: {} });
    for (const { value } of replyDrafts) console.log(JSON.stringify(value));
  } else {
    const { dispatchState } = await agent.read({ dispatchState: {} });
    for (const { scope } of dispatchState) {
      if (scope.startsWith('pickup:')) continue;
      const journal = await agent.readDispatch(scope);
      if (journal) console.log(JSON.stringify(journal));
    }
  }
}
