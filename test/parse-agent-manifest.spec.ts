import assert from 'node:assert/strict';

import parseAgentManifest from '../utils/parse-agent-manifest.ts';

function diagnosticCodes(source: string): Set<string> {
  const result = parseAgentManifest(source);
  return new Set(result.diagnostics.map(({ code }) => code));
}

describe('utils/parse-agent-manifest', () => {
  it('should parse identity and environment data without converting variable names', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
  name: Tanaabot
  description: Tanaab development agent.
  avatar: .agent-system/assets/tanaabot.png
environment:
  dotenv:
    - .agent-system/env/base.env
    - .agent-system/env/local.env
  onepassword-environments:
    - env-team
    - env-agent
  required:
    - AGENT_COLOR
  set:
    AGENT_COLOR: green
    GitHub_User: tanaabot
`);

    assert.deepEqual(result, {
      status: 'valid',
      manifest: {
        schemaVersion: 1,
        agent: {
          id: 'tanaabot',
          name: 'Tanaabot',
          description: 'Tanaab development agent.',
          avatar: '.agent-system/assets/tanaabot.png',
        },
        environment: {
          dotenv: ['.agent-system/env/base.env', '.agent-system/env/local.env'],
          onePasswordEnvironments: ['env-team', 'env-agent'],
          required: ['AGENT_COLOR'],
          set: {
            AGENT_COLOR: 'green',
            GitHub_User: 'tanaabot',
          },
        },
      },
      diagnostics: [],
    });
  });

  it('should normalize one 1password environment id to the ordered internal list', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
environment:
  onepassword-environments: env-agent
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.environment?.onePasswordEnvironments, ['env-agent']);
  });

  it('should normalize one dotenv path to the ordered internal list', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
environment:
  dotenv: .agent-system/env/agent.env
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.environment?.dotenv, ['.agent-system/env/agent.env']);
  });

  it('should reject duplicate yaml keys', () => {
    assert.deepEqual(
      diagnosticCodes('schema-version: 1\nschema-version: 1\nagent:\n  id: tanaabot\n'),
      new Set(['yaml-duplicate-key']),
    );
  });

  it('should reject yaml anchors and aliases', () => {
    assert.deepEqual(
      diagnosticCodes('schema-version: &version 1\nagent:\n  id: tanaabot\n  name: *version\n'),
      new Set(['yaml-anchor', 'yaml-alias']),
    );
  });

  it('should reject explicit yaml tags', () => {
    assert.deepEqual(
      diagnosticCodes('schema-version: 1\nagent:\n  id: !agent tanaabot\n'),
      new Set(['yaml-tag']),
    );
  });

  it('should reject unknown and incorrectly cased schema keys', () => {
    const result = parseAgentManifest(`
schemaVersion: 1
agent:
  id: tanaabot
`);

    assert.equal(result.status, 'invalid');
    assert.equal(
      diagnosticCodes(`
schemaVersion: 1
agent:
  id: tanaabot
`).has('manifest-unknown-key'),
      true,
    );
    assert.equal(
      result.diagnostics.some(({ message }) => message.includes('placeholder')),
      false,
    );
  });

  it('should reject non-string literals and invalid environment variable names', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
environment:
  set:
    VALID_NAME: 123
    not-valid-name: value
`);

    assert.equal(result.status, 'invalid');
    assert.equal(
      result.diagnostics.every(({ code }) => code === 'manifest-schema'),
      true,
    );
  });

  it('should reject empty and duplicate required variable lists', () => {
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
environment:
  required: []
`).has('manifest-schema'),
      true,
    );
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
environment:
  required:
    - AGENT_COLOR
    - AGENT_COLOR
`).has('manifest-schema'),
      true,
    );
  });

  it('should reject empty, blank, and duplicate dotenv declarations', () => {
    for (const dotenv of [
      '[]',
      "''",
      "'   '",
      '[.agent-system/env/base.env, .agent-system/env/base.env]',
    ]) {
      assert.equal(
        diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
environment:
  dotenv: ${dotenv}
`).has('manifest-schema'),
        true,
      );
    }
  });

  it('should reject empty, blank, and duplicate 1password environment declarations', () => {
    for (const environments of ['[]', "''", "'   '", '[env-agent, env-agent]']) {
      assert.equal(
        diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
environment:
  onepassword-environments: ${environments}
`).has('manifest-schema'),
        true,
      );
    }
  });

  it('should reject unknown environment keys without exposing their values', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
environment:
  file: private-value
`);

    assert.equal(result.status, 'invalid');
    assert.equal(
      result.diagnostics.some(({ code }) => code === 'manifest-unknown-key'),
      true,
    );
    assert.equal(
      result.diagnostics.some(({ message }) => message.includes('private-value')),
      false,
    );
  });

  it('should require a canonical lowercase agent id', () => {
    assert.deepEqual(
      diagnosticCodes('schema-version: 1\nagent:\n  id: Tanaabot\n'),
      new Set(['manifest-schema']),
    );
  });
});
