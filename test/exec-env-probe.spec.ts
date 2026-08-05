import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  buildEnableGatewayExecCommand,
  createExecEnvironmentProbe,
  parseExecEnvironmentProbeResult,
  parseExecEnvironmentProbeSession,
  resolveExecEnvironmentProbeValues,
} from '../utils/exec-env-probe.ts';
import type { AgentEnvironmentVariable } from '../utils/resolve-agent-environment.ts';

const variables: AgentEnvironmentVariable[] = [
  { name: 'GITHUB_TOKEN', source: 'environment.set', staticExecDelivery: 'documented-filtered' },
  { name: 'AGENT_COLOR', source: 'environment.set', staticExecDelivery: 'exec-candidate' },
];
const nonce = '11111111-2222-3333-4444-555555555555';

describe('utils/exec-env-probe', () => {
  it('should create a reserved session and one-time values without embedding manifest values', () => {
    const probe = createExecEnvironmentProbe('data', variables, {
      nodePath: '/usr/bin/node',
      nonce,
    });
    const sentinels = resolveExecEnvironmentProbeValues(probe.sessionKey, 'data', probe.variables);

    assert.deepEqual(parseExecEnvironmentProbeSession(probe.sessionKey), {
      agentId: 'data',
      nonce,
    });
    assert.equal(probe.command.includes('private-value'), false);
    assert.equal((sentinels?.AGENT_COLOR ?? '').startsWith('agent-system-env-probe-'), true);
    assert.notEqual(sentinels?.AGENT_COLOR, sentinels?.GITHUB_TOKEN);
  });

  it('should ignore malformed, cross-agent, and ordinary sessions', () => {
    const probe = createExecEnvironmentProbe('data', variables, { nonce });

    assert.equal(
      resolveExecEnvironmentProbeValues('agent:data:ordinary', 'data', variables),
      undefined,
    );
    assert.equal(
      resolveExecEnvironmentProbeValues(probe.sessionKey, 'other', variables),
      undefined,
    );
  });

  it('should map the Gateway probe result onto all requested names', () => {
    const probe = createExecEnvironmentProbe('data', variables, { nonce });
    const encoded = Buffer.from(JSON.stringify(['AGENT_COLOR'])).toString('base64url');
    const result = parseExecEnvironmentProbeResult(
      { output: { content: [{ type: 'text', text: `AGENT_SYSTEM_ENV_PROBE_RESULT=${encoded}` }] } },
      probe,
    );

    assert.deepEqual(
      result.map(({ name, observedExecDelivery }) => ({ name, observedExecDelivery })),
      [
        { name: 'AGENT_COLOR', observedExecDelivery: 'accepted' },
        { name: 'GITHUB_TOKEN', observedExecDelivery: 'filtered' },
      ],
    );
  });

  it('should run the fixed probe command without printing sentinel values', () => {
    const probe = createExecEnvironmentProbe('data', variables, { nonce });
    const sentinels = resolveExecEnvironmentProbeValues(probe.sessionKey, 'data', variables);
    const output = execFileSync('/bin/sh', ['-c', probe.command], {
      encoding: 'utf8',
      env: { ...process.env, ...sentinels },
    });

    assert.equal(output.startsWith('AGENT_SYSTEM_ENV_PROBE_RESULT='), true);
    assert.equal(
      Object.values(sentinels ?? {}).some((value) => output.includes(value)),
      false,
    );
    assert.equal(
      parseExecEnvironmentProbeResult({ output }, probe).every(
        ({ observedExecDelivery }) => observedExecDelivery === 'accepted',
      ),
      true,
    );
  });

  it('should preserve existing allow entries in the opt-in command', () => {
    assert.equal(
      buildEnableGatewayExecCommand(['browser']),
      `openclaw config set gateway.tools.allow '["browser","exec"]' --strict-json`,
    );
  });
});
