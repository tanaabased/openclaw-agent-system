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
      ['examples/openclaw-issue-intake/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-issue-intake/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      [
        'examples/openclaw-issue-assessment-recovery/emori/agent.yaml',
        'GH_TOKEN_EMORI',
        'emoriwan',
      ],
      [
        'examples/openclaw-issue-assessment-recovery/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
      ['examples/openclaw-issue-feedback-policy/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      [
        'examples/openclaw-issue-feedback-policy/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
      ['examples/openclaw-issue-assignment-policy/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      [
        'examples/openclaw-issue-assignment-policy/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
      ['examples/openclaw-issue-reactivation/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-issue-reactivation/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-notifications-retirement/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      [
        'examples/openclaw-notifications-retirement/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
      ['examples/openclaw-notifications-reset/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      [
        'examples/openclaw-notifications-reset/tanaabot/agent.yaml',
        'GH_TOKEN_TANAABOT',
        'tanaabot',
      ],
      ['examples/openclaw-issue-conversation/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-issue-conversation/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-issue-assessment/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-issue-assessment/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-github-reply/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-github-reply/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-issue-journey/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-issue-journey/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-issue-progression/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-issue-progression/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-pr-recipients/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-pr-recipients/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-pr-update/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-pr-update/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-pr-presentation/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-pr-presentation/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-pr-collaboration/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-pr-collaboration/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-pr-discovery/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-pr-discovery/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-pr-reply-recovery/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-pr-reply-recovery/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
      ['examples/openclaw-pr-journey/emori/agent.yaml', 'GH_TOKEN_EMORI', 'emoriwan'],
      ['examples/openclaw-pr-journey/tanaabot/agent.yaml', 'GH_TOKEN_TANAABOT', 'tanaabot'],
    ] as const) {
      const parsed = parseAgentManifest(
        (await readFile(path, 'utf8'))
          .replaceAll('__ACTOR_NODE_ID__', 'U_actor')
          .replaceAll('__MILESTONE_NUMBER__', '123'),
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
