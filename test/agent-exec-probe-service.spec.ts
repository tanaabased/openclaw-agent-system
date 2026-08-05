import assert from 'node:assert/strict';

import AgentExecProbeService from '../lib/agent-exec-probe-service.ts';
import type { AgentEnvironmentVariable } from '../utils/resolve-agent-environment.ts';

const variables: AgentEnvironmentVariable[] = [
  { name: 'AGENT_COLOR', source: 'environment.set', staticExecDelivery: 'exec-candidate' },
  { name: 'GITHUB_TOKEN', source: 'environment.set', staticExecDelivery: 'documented-filtered' },
];

describe('lib/agent-exec-probe-service', () => {
  it('should report configuration read failures without invoking the Gateway', async () => {
    let calledGateway = false;
    const service = new AgentExecProbeService({
      async callGateway() {
        calledGateway = true;
        return {};
      },
      logger: { info() {}, warn() {} },
      readConfig() {
        throw new Error('private config detail');
      },
    });

    const result = await service.probe('data', variables);

    assert.equal(calledGateway, false);
    assert.deepEqual(result, {
      status: 'failed',
      code: 'exec-probe-failed',
      message: 'The current OpenClaw configuration could not be read.',
    });
  });

  it('should fail before Gateway invocation when direct exec is not explicitly allowed', async () => {
    const calls: unknown[] = [];
    const service = new AgentExecProbeService({
      async callGateway(method, params) {
        calls.push({ method, params });
        return {};
      },
      logger: { info() {}, warn() {} },
      readConfig: () => ({ gateway: { tools: { allow: ['browser'] } } }),
    });

    const result = await service.probe('data', variables);

    assert.equal(result.status, 'disabled');
    assert.deepEqual(calls, []);
    if (result.status === 'disabled') assert.equal(result.enableCommand.includes('browser'), true);
  });

  it('should invoke exec on the Gateway and report observed delivery', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const service = new AgentExecProbeService({
      async callGateway(method, params) {
        calls.push({ method, params });
        const request = params as { sessionKey: string };
        const hookValues = await import('../utils/exec-env-probe.ts').then(
          ({ resolveExecEnvironmentProbeValues }) =>
            resolveExecEnvironmentProbeValues(request.sessionKey, 'data', variables),
        );
        const accepted = Object.keys(hookValues ?? {}).filter((name) => name === 'AGENT_COLOR');
        const encoded = Buffer.from(JSON.stringify(accepted)).toString('base64url');
        return { output: `AGENT_SYSTEM_ENV_PROBE_RESULT=${encoded}` };
      },
      logger: { info() {}, warn() {} },
      nodePath: '/usr/bin/node',
      readConfig: () => ({ gateway: { tools: { allow: ['exec'] } } }),
    });

    const result = await service.probe('data', variables);

    assert.equal(calls[0]?.method, 'tools.invoke');
    assert.equal((calls[0]?.params as { args: { host: string } }).args.host, 'gateway');
    assert.equal(result.status, 'completed');
    if (result.status !== 'completed') return;
    assert.deepEqual(
      result.variables.map(({ name, observedExecDelivery }) => ({ name, observedExecDelivery })),
      [
        { name: 'AGENT_COLOR', observedExecDelivery: 'accepted' },
        { name: 'GITHUB_TOKEN', observedExecDelivery: 'filtered' },
      ],
    );
  });

  it('should classify Gateway connection and approval failures', async () => {
    for (const [message, code] of [
      ['Gateway connection refused', 'gateway-unavailable'],
      ['requires_approval', 'exec-probe-approval-required'],
    ] as const) {
      const service = new AgentExecProbeService({
        async callGateway() {
          throw new Error(message);
        },
        logger: { info() {}, warn() {} },
        readConfig: () => ({ gateway: { tools: { allow: ['exec'] } } }),
      });

      const result = await service.probe('data', variables);
      assert.equal(result.status, 'failed');
      if (result.status === 'failed') assert.equal(result.code, code);
    }
  });

  it('should preserve structured approval failures returned by tools.invoke', async () => {
    const service = new AgentExecProbeService({
      async callGateway() {
        return {
          ok: false,
          requiresApproval: true,
          error: { code: 'requires_approval', message: 'exec requires approval' },
        };
      },
      logger: { info() {}, warn() {} },
      readConfig: () => ({ gateway: { tools: { allow: ['exec'] } } }),
    });

    const result = await service.probe('data', variables);

    assert.deepEqual(result, {
      status: 'failed',
      code: 'exec-probe-approval-required',
      message: 'exec requires approval',
    });
  });

  it('should recognize an exec tool approval result without parsing its command', async () => {
    const service = new AgentExecProbeService({
      async callGateway() {
        return {
          ok: true,
          output: {
            details: { status: 'approval-pending', command: 'probe command' },
          },
        };
      },
      logger: { info() {}, warn() {} },
      readConfig: () => ({ gateway: { tools: { allow: ['exec'] } } }),
    });

    const result = await service.probe('data', variables);

    assert.deepEqual(result, {
      status: 'failed',
      code: 'exec-probe-approval-required',
      message: 'OpenClaw exec approval is required before the probe can run.',
    });
  });
});
