import assert from 'node:assert/strict';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';

import createToolSecurityLifecycleContribution from '../api/security-lifecycle.ts';

const input = {
  manifest: {
    schemaVersion: 1 as const,
    agent: { id: 'emori', name: 'Emori' },
    github: {},
  },
  workspaceDir: '/workspace/emori',
};

async function inspect(config: OpenClawConfig) {
  const contribution = createToolSecurityLifecycleContribution({ readConfig: () => config });
  return contribution.inspect?.(input);
}

describe('api/security-lifecycle', () => {
  it('should warn when default command execution can reach operator surfaces', async () => {
    const findings = await inspect({});

    assert.equal(findings?.[0]?.code, 'agent-operator-boundary-exposed');
    assert.equal(findings?.[0]?.status, 'warning');
  });

  it('should accept agent-scoped sandbox execution with elevated execution disabled', async () => {
    const findings = await inspect({
      agents: {
        defaults: {
          sandbox: { mode: 'all', scope: 'agent' },
        },
      },
      tools: { elevated: { enabled: false } },
    });

    assert.equal(findings?.[0]?.code, 'agent-command-posture-contained');
    assert.equal(findings?.[0]?.status, 'healthy');
  });

  it('should warn when elevated execution bypasses an agent-scoped sandbox', async () => {
    const findings = await inspect({
      agents: { defaults: { sandbox: { mode: 'all', scope: 'agent' } } },
    });

    assert.equal(findings?.[0]?.code, 'agent-operator-boundary-exposed');
  });

  it('should warn when a shared sandbox can cross agent boundaries', async () => {
    const findings = await inspect({
      agents: {
        defaults: {
          sandbox: { mode: 'all', scope: 'shared' },
        },
      },
      tools: { elevated: { enabled: false } },
    });

    assert.equal(findings?.[0]?.code, 'agent-operator-boundary-exposed');
  });

  it('should apply an explicit per-agent exec host over global sandbox routing', async () => {
    const findings = await inspect({
      agents: {
        defaults: { sandbox: { mode: 'all', scope: 'agent' } },
        list: [{ id: 'emori', tools: { exec: { host: 'gateway' } } }],
      },
      tools: { elevated: { enabled: false } },
    });

    assert.equal(findings?.[0]?.code, 'agent-operator-boundary-exposed');
  });

  it('should accept denied command execution with elevated execution disabled', async () => {
    const findings = await inspect({
      tools: { elevated: { enabled: false }, exec: { mode: 'deny' } },
    });

    assert.equal(findings?.[0]?.code, 'agent-command-posture-contained');
  });
});
