import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import resolveAgentEnvironment from '../environment/resolve.ts';
import parseAgentManifest from '../manifest/parse.ts';

describe('example environment resolution', () => {
  it('should resolve only each token-only fixture account and reject missing or empty tokens', async () => {
    const tokens = {
      GH_TOKEN_EMORI: 'synthetic-emori-token',
      GH_TOKEN_TANAABOT: 'synthetic-tanaabot-token',
    };
    for (const [path, token, username] of [
      ['examples/openclaw-tools/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-github/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-github/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-notifications-intake/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      [
        'examples/openclaw-notifications-intake/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
      ['examples/openclaw-notifications-lifecycle/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      [
        'examples/openclaw-notifications-lifecycle/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
      ['examples/openclaw-notifications-issue/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      [
        'examples/openclaw-notifications-issue/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
      [
        'examples/openclaw-notifications-progression/emori/agent.yaml',
        'GH_TOKEN_EMORI',
        'emoriwan',
      ],
      [
        'examples/openclaw-notifications-progression/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
      [
        'examples/openclaw-notifications-pr-delivery/emori/agent.yaml',
        'GH_TOKEN_EMORI',
        'emoriwan',
      ],
      [
        'examples/openclaw-notifications-pr-delivery/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
    ] as const) {
      const parsed = parseAgentManifest(
        (await readFile(path, 'utf8'))
          .replaceAll('__OWNER_NODE_ID__', 'O_owner')
          .replaceAll('__ACTOR_NODE_ID__', 'U_actor'),
      );
      assert.equal(parsed.status, 'valid', path);
      assert.ok(parsed.manifest);
      assert.equal(parsed.manifest.environment?.op, undefined);
      assert.equal(parsed.manifest.github?.username, username);
      assert.equal(parsed.manifest.github?.token, token);
      const resolved = resolveAgentEnvironment(parsed.manifest, tokens);
      assert.equal(resolved.status, 'resolved', path);
      assert.ok(resolved.status === 'resolved');
      assert.deepEqual(resolved.environment.values, { [token]: tokens[token] });
      for (const missing of [undefined, '']) {
        const result = resolveAgentEnvironment(parsed.manifest, { ...tokens, [token]: missing });
        assert.equal(result.status, 'invalid', path);
        assert.ok(result.status === 'invalid');
        const expectedCode =
          missing === undefined ? 'environment-reference-missing' : 'environment-required-missing';
        assert.ok(result.diagnostics.some(({ code }) => code === expectedCode));
      }
    }
  });
});
