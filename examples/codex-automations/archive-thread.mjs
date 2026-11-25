import assert from 'node:assert/strict';

import { codexThreadAdapter, connectCodexThreads } from '../../agent/codex-thread-client.ts';

const [workspace, id, mode] = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME;
assert.ok(workspace && id && codexHome);
const { request, close } = await connectCodexThreads(workspace, codexHome);
try {
  if (mode === 'archive') await request('thread/archive', { threadId: id });
  else {
    assert.equal(mode, 'verify');
    assert.equal((await codexThreadAdapter(request, workspace).lookup(id))?.archived, true);
  }
} finally {
  await close();
}
