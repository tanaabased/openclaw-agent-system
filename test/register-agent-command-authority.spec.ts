import assert from 'node:assert/strict';

import { deniedAgentCommandEnvironment } from '../lib/agent-command-authority.ts';
import registerAgentCommandAuthority from '../lib/register-agent-command-authority.ts';

describe('lib/register-agent-command-authority', () => {
  it('should issue a capability only for a loaded Gateway agent context', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const services: Array<{ id: string; start(): unknown; stop?(): unknown }> = [];
    const calls: string[] = [];
    registerAgentCommandAuthority(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
        registerService(service: { id: string; start(): unknown; stop?(): unknown }) {
          services.push(service);
        },
      } as never,
      {
        authority: {
          issue(agentId) {
            calls.push(`issue:${agentId}`);
            return { AGENT_SYSTEM_EXEC_CAPABILITY: 'opaque' };
          },
          async start() {
            calls.push('start');
          },
          async stop() {
            calls.push('stop');
          },
        },
        logger: { error() {}, info() {}, warn() {} },
        manifestService: {
          async loadForRuntimeContext(_context, trigger) {
            calls.push(`manifest:${trigger}`);
            return {
              status: 'loaded',
              scope: { agentId: 'data', workspaceDir: '/workspace/data' },
              path: '/workspace/data/.agent-system/agent.yaml',
              digest: 'digest',
              manifest: { schemaVersion: 1, agent: { id: 'data' } },
              diagnostics: [],
              validationChecks: [],
            } as const;
          },
        },
      },
    );

    await services[0]?.start();
    const sandbox = await handlers.get('resolve_exec_env')?.(
      { host: 'sandbox', toolName: 'exec' },
      { agentId: 'data' },
    );
    const gateway = await handlers.get('resolve_exec_env')?.(
      { host: 'gateway', toolName: 'exec' },
      { agentId: 'data' },
    );
    await services[0]?.stop?.();

    assert.equal(sandbox, undefined);
    assert.deepEqual(gateway, { AGENT_SYSTEM_EXEC_CAPABILITY: 'opaque' });
    assert.deepEqual(calls, ['start', 'manifest:resolve_exec_env', 'issue:data', 'stop']);
  });

  it('should deny gateway descendants when startup and agent resolution are unavailable', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const services: Array<{ id: string; start(): unknown; stop?(): unknown }> = [];
    const errors: string[] = [];
    registerAgentCommandAuthority(
      {
        on(name: string, handler: (...args: unknown[]) => unknown) {
          handlers.set(name, handler);
        },
        registerService(service: { id: string; start(): unknown; stop?(): unknown }) {
          services.push(service);
        },
      } as never,
      {
        authority: {
          issue() {
            throw new Error('issue must not be reached without a resolved agent');
          },
          async start() {
            throw new Error('authority unavailable');
          },
          async stop() {},
        },
        logger: { error: (message) => errors.push(message), info() {}, warn() {} },
        manifestService: {
          async loadForRuntimeContext() {
            return { status: 'unresolved', diagnostics: [] } as const;
          },
        },
      },
    );

    await services[0]?.start();
    const gateway = await handlers.get('resolve_exec_env')?.(
      { host: 'gateway', toolName: 'exec' },
      { agentId: 'data' },
    );

    assert.deepEqual(gateway, deniedAgentCommandEnvironment());
    assert.deepEqual(errors, ['security: agent_command_authority_start_failed']);
  });
});
