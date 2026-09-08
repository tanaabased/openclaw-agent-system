import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

describe('scripts/openclaw-setup', () => {
  it('should accept declared capabilities when installing an Agent System package', async () => {
    const source = await readFile('scripts/openclaw-setup', 'utf8');

    assert.match(
      source,
      /plugins install "npm-pack:\$agent_system_plugin" --force --accept-capabilities/u,
    );
  });
});
