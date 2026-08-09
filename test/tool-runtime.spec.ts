import assert from 'node:assert/strict';

import AgentSystemToolApprovalReceiptStore from '../lib/tool-approval-receipt-store.ts';
import AgentSystemToolError from '../lib/tool-error.ts';
import AgentSystemToolRuntime from '../lib/tool-runtime.ts';
import type { AgentSystemAuditEvent, AgentSystemCliRunRequest } from '../lib/tool-types.ts';
import {
  createToolTestDefinition,
  loadedToolTestManifest,
  toolTestWorkspaceDir,
} from './tool-test-fixture.ts';

function createRuntime(options: {
  approvals?: AgentSystemToolApprovalReceiptStore;
  auditEvents?: AgentSystemAuditEvent[];
  environmentCalls?: string[];
  events?: string[];
  logs?: string[];
  runCli?: (request: AgentSystemCliRunRequest) => Promise<{
    exitCode: number | null;
    stderr: string;
    stdout: string;
    timedOut: boolean;
    truncated: boolean;
  }>;
}): AgentSystemToolRuntime {
  const auditEvents = options.auditEvents ?? [];
  const environmentCalls = options.environmentCalls ?? [];
  const events = options.events ?? [];
  const logs = options.logs ?? [];
  return new AgentSystemToolRuntime({
    ...(options.approvals ? { approvals: options.approvals } : {}),
    audit: {
      record(event) {
        auditEvents.push(event);
        events.push(`audit:${event.phase}`);
      },
    },
    baseEnvironment: { PATH: '/usr/bin', SHOULD_NOT_INHERIT: 'host-private' },
    environmentService: {
      async loadForAgentId(agentId) {
        environmentCalls.push(agentId);
        events.push('environment');
        return {
          ...loadedToolTestManifest(),
          environment: {
            values: { AGENT_TOKEN: 'private-token' },
            variables: [],
          },
        };
      },
    },
    logger: {
      error(message) {
        logs.push(message);
      },
      info(message) {
        logs.push(message);
      },
    },
    manifestService: {
      async loadForAgentId() {
        return loadedToolTestManifest();
      },
      async loadForCommandDirectory() {
        return loadedToolTestManifest();
      },
    },
    runCli:
      options.runCli ??
      (async (request) => {
        events.push('run');
        return {
          exitCode: 0,
          stderr: '',
          stdout: `${request.argv[0]}\n`,
          timedOut: false,
          truncated: false,
        };
      }),
  });
}

describe('lib/tool-runtime', () => {
  it('should deny an operation before resolving its credential environment', async () => {
    const events: string[] = [];
    const auditEvents: AgentSystemAuditEvent[] = [];
    const runtime = createRuntime({ auditEvents, events });
    const definition = createToolTestDefinition({
      authorize() {
        events.push('authorize');
        return { status: 'denied', reason: 'Test policy denied this operation.' };
      },
    });

    await assert.rejects(
      runtime.executeCli(
        definition,
        { argument: 'status' },
        { agentId: 'data', source: 'command' },
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError &&
        error.code === 'approval_denied' &&
        error.message === 'Test policy denied this operation.',
    );
    assert.deepEqual(events, ['authorize']);
    assert.deepEqual(auditEvents, []);
  });

  it('should audit a successful execution around credential resolution', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const events: string[] = [];
    const requests: AgentSystemCliRunRequest[] = [];
    const runtime = createRuntime({
      auditEvents,
      events,
      runCli: async (request) => {
        requests.push(request);
        events.push('run');
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'ok\n',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const definition = createToolTestDefinition({
      authorize() {
        events.push('authorize');
        return { status: 'allowed' };
      },
    });

    const result = await runtime.executeCli(
      definition,
      { argument: 'status' },
      { agentId: 'data', source: 'command' },
    );

    assert.equal(result.output, 'ok\n');
    assert.deepEqual(events, [
      'authorize',
      'audit:pending',
      'environment',
      'run',
      'audit:completed',
    ]);
    assert.deepEqual(
      auditEvents.map(({ phase, status }) => ({ phase, status })),
      [
        { phase: 'pending', status: undefined },
        { phase: 'completed', status: 'ok' },
      ],
    );
    assert.equal(requests[0]?.environment.TOOL_TOKEN, 'private-token');
    assert.equal(requests[0]?.environment.PATH, '/usr/bin');
    assert.equal(requests[0]?.environment.SHOULD_NOT_INHERIT, undefined);
    assert.equal(JSON.stringify(auditEvents).includes('private-token'), false);
  });

  it('should report a stable error and failed audit when the executable is unavailable', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const logs: string[] = [];
    const runtime = createRuntime({
      auditEvents,
      logs,
      async runCli() {
        throw new Error('runner exposed private-token');
      },
    });

    await assert.rejects(
      runtime.executeCli(
        createToolTestDefinition(),
        { argument: 'status' },
        { agentId: 'data', source: 'command' },
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError &&
        error.code === 'tool_unavailable' &&
        error.message === 'The test-tool tool executable is unavailable.',
    );
    assert.deepEqual(
      auditEvents.map(({ phase, status }) => ({ phase, status })),
      [
        { phase: 'pending', status: undefined },
        { phase: 'failed', status: 'tool_unavailable' },
      ],
    );
    assert.equal(logs.join('\n').includes('private-token'), false);
  });

  it('should consume one exact approval receipt before resolving credentials', async () => {
    const approvals = new AgentSystemToolApprovalReceiptStore();
    const environmentCalls: string[] = [];
    const input = { argument: 'delete' };
    approvals.record({ agentId: 'data', input, toolCallId: 'approved-call', toolId: 'test-tool' });
    const runtime = createRuntime({ approvals, environmentCalls });
    const definition = createToolTestDefinition({
      authorize: () => ({
        status: 'approval_required',
        reason: 'Test policy requires approval.',
        request: { description: 'Delete test data.', severity: 'critical', title: 'Delete data' },
      }),
    });
    const scope = {
      source: 'tool' as const,
      toolCallId: 'approved-call',
      toolContext: { agentId: 'data', workspaceDir: toolTestWorkspaceDir } as never,
    };

    await runtime.executeCli(definition, input, scope);
    await assert.rejects(
      runtime.executeCli(definition, input, scope),
      (error: unknown) => error instanceof AgentSystemToolError && error.code === 'approval_denied',
    );
    assert.deepEqual(environmentCalls, ['data']);
  });
});
