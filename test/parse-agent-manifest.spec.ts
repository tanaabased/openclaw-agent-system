import assert from 'node:assert/strict';

import parseAgentManifest from '../utils/parse-agent-manifest.ts';

function diagnosticCodes(source: string): Set<string> {
  const result = parseAgentManifest(source);
  return new Set(result.diagnostics.map(({ code }) => code));
}

describe('utils/parse-agent-manifest', () => {
  it('should parse identity and literal environment data without converting variable names', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
  name: Tanaabot
  description: Tanaab development agent.
  avatar: .agent-system/assets/tanaabot.png
environment:
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
          set: {
            AGENT_COLOR: 'green',
            GitHub_User: 'tanaabot',
          },
        },
      },
      diagnostics: [],
    });
  });

  it('should reject duplicate YAML keys', () => {
    assert.deepEqual(
      diagnosticCodes('schema-version: 1\nschema-version: 1\nagent:\n  id: tanaabot\n'),
      new Set(['yaml-duplicate-key']),
    );
  });

  it('should reject YAML anchors and aliases', () => {
    assert.deepEqual(
      diagnosticCodes('schema-version: &version 1\nagent:\n  id: tanaabot\n  name: *version\n'),
      new Set(['yaml-anchor', 'yaml-alias']),
    );
  });

  it('should reject explicit YAML tags', () => {
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
