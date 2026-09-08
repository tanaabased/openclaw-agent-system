import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

describe('scripts/openclaw-setup', () => {
  it('should authorize Agent System capabilities and conversation hooks', async () => {
    const source = await readFile('scripts/openclaw-setup', 'utf8');

    assert.match(
      source,
      /plugins install "npm-pack:\$agent_system_plugin" --force --accept-capabilities/u,
    );
    assert.match(
      source,
      /config set plugins\.entries\.agent-system\.hooks\.allowConversationAccess true/u,
    );
    assert.match(source, /\.policy\.allowConversationAccess == true/u);
    assert.match(source, /\.name == "before_prompt_build"/u);
  });
});
