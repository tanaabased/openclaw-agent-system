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
  email:
    from-environment: AGENT_EMAIL
  description: Tanaab development agent.
  avatar: .agent-system/assets/tanaabot.png
environment:
  dotenv:
    - .agent-system/env/base.env
    - .agent-system/env/local.env
  op:
    - env-team
    - env-agent
  path-prepend:
    - tools/bin
    - vendor/bin
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
          email: { fromEnvironment: 'AGENT_EMAIL' },
          description: 'Tanaab development agent.',
          avatar: '.agent-system/assets/tanaabot.png',
        },
        environment: {
          dotenv: ['.agent-system/env/base.env', '.agent-system/env/local.env'],
          op: ['env-team', 'env-agent'],
          pathPrepend: ['tools/bin', 'vendor/bin'],
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

  it('should parse literal and environment-backed agent values', () => {
    const literal = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
  name: Tanaabot
  email: tanaabot@example.com
`);
    const referenced = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
  name:
    from-environment: AGENT_NAME
  email:
    from-environment: AGENT_EMAIL
`);

    assert.equal(literal.status, 'valid');
    if (literal.status === 'valid') {
      assert.equal(literal.manifest.agent.name, 'Tanaabot');
      assert.equal(literal.manifest.agent.email, 'tanaabot@example.com');
    }
    assert.equal(referenced.status, 'valid');
    if (referenced.status === 'valid') {
      assert.deepEqual(referenced.manifest.agent.name, { fromEnvironment: 'AGENT_NAME' });
      assert.deepEqual(referenced.manifest.agent.email, { fromEnvironment: 'AGENT_EMAIL' });
    }
  });

  it('should parse direct op secret references only in environment.set object form', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
environment:
  set:
    LITERAL_REFERENCE: op://vault/item/field
    SSH_KEY:
      from-op: op://vault/item/keys/private%20key?ssh-format=openssh
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.environment?.set, {
      LITERAL_REFERENCE: 'op://vault/item/field',
      SSH_KEY: { fromOp: 'op://vault/item/keys/private%20key?ssh-format=openssh' },
    });
  });

  it('should reject malformed or expanded environment.set op reference objects', () => {
    for (const value of [
      '{ from-op: vault/item/field }',
      '{ from-op: op://vault/item }',
      '{ from-op: op://vault/item/field, fallback: value }',
      '{ from-environment: SSH_KEY }',
    ]) {
      const codes = diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
environment:
  set:
    SSH_KEY: ${value}
`);
      assert.equal(codes.has('manifest-schema') || codes.has('manifest-unknown-key'), true);
    }
  });

  it('should keep dollar-prefixed agent strings literal', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
  name: $AGENT_NAME
  email: \${AGENT_EMAIL}
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.equal(result.manifest.agent.name, '$AGENT_NAME');
    assert.equal(result.manifest.agent.email, '${AGENT_EMAIL}');
  });

  it('should reject invalid agent environment references', () => {
    for (const value of [
      '{ from-environment: agent_name }',
      '{ from-environment: AGENT_NAME, fallback: Tanaabot }',
      '{ fromEnvironment: AGENT_NAME }',
    ]) {
      assert.equal(
        diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
  name: ${value}
`).has(
          value.includes('fallback') || value.includes('fromEnvironment')
            ? 'manifest-unknown-key'
            : 'manifest-schema',
        ),
        true,
      );
    }
  });

  it('should keep agent id literal-only', () => {
    assert.equal(
      diagnosticCodes(`
schema-version: 1
agent:
  id:
    from-environment: AGENT_ID
`).has('manifest-schema'),
      true,
    );
  });

  it('should normalize one workspace path prepend to the ordered internal list', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
environment:
  path-prepend: tools/bin
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.environment?.pathPrepend, ['tools/bin']);
  });

  it('should normalize one 1password environment id to the ordered internal list', () => {
    const result = parseAgentManifest(`
schema-version: 1
agent:
  id: tanaabot
environment:
  op: env-agent
`);

    assert.equal(result.status, 'valid');
    if (result.status !== 'valid') return;
    assert.deepEqual(result.manifest.environment?.op, ['env-agent']);
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

  it('should reject legacy or expanded op environment aliases', () => {
    for (const key of ['onepassword-environments', 'onepassword-environment', 'ops']) {
      assert.equal(
        diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
environment:
  ${key}: private-environment-id
`).has('manifest-unknown-key'),
        true,
      );
    }
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
  op: ${environments}
`).has('manifest-schema'),
        true,
      );
    }
  });

  it('should reject empty, absolute, and duplicate path prepend declarations', () => {
    for (const paths of ['[]', "''", "'   '", '/usr/local/bin', '[tools/bin, tools/bin]']) {
      assert.equal(
        diagnosticCodes(`
schema-version: 1
agent:
  id: tanaabot
environment:
  path-prepend: ${paths}
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
