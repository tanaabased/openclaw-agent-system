import assert from 'node:assert/strict';

import AgentSystemToolApprovalReceiptStore from '../lib/tool-approval-receipt-store.ts';
import AgentSystemToolError from '../lib/tool-error.ts';
import AgentSystemToolRuntime from '../lib/tool-runtime.ts';
import type { AgentSystemAuditEvent, AgentSystemCliRunRequest } from '../lib/tool-types.ts';
import {
  createSemanticToolTestDefinition,
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
  it('should run semantic operations through authorization, environment, and audit', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const events: string[] = [];
    const runtime = createRuntime({ auditEvents, events });
    const definition = createSemanticToolTestDefinition({
      authorize() {
        events.push('authorize');
        return { status: 'allowed' };
      },
      async execute(input, configuration) {
        events.push('execute');
        return `${input.argument}:${configuration.token}`;
      },
    });

    const result = await runtime.executeSemantic(
      definition,
      { argument: 'status' },
      { agentId: 'data', source: 'command' },
    );

    assert.equal(result.output, 'status:AGENT_TOKEN');
    assert.equal(result.kind, 'semantic');
    assert.equal(Object.hasOwn(result, 'commandResult'), false);
    assert.equal(auditEvents.at(-1)?.truncated, undefined);
    assert.deepEqual(events, [
      'authorize',
      'audit:pending',
      'environment',
      'execute',
      'audit:completed',
    ]);
    assert.deepEqual(
      auditEvents.map(({ phase, status }) => ({ phase, status })),
      [
        { phase: 'pending', status: undefined },
        { phase: 'completed', status: 'ok' },
      ],
    );
  });

  it('should deny semantic operations before resolving the environment', async () => {
    const events: string[] = [];
    const runtime = createRuntime({ events });
    const definition = createSemanticToolTestDefinition({
      authorize() {
        events.push('authorize');
        return { status: 'denied', reason: 'Test policy denied this operation.' };
      },
      async execute() {
        events.push('execute');
        return 'unexpected';
      },
    });

    await assert.rejects(
      runtime.executeSemantic(
        definition,
        { argument: 'status' },
        { agentId: 'data', source: 'command' },
      ),
      (error: unknown) => error instanceof AgentSystemToolError && error.code === 'approval_denied',
    );
    assert.deepEqual(events, ['authorize']);
  });

  it('should deny an operation before resolving its credential environment', async () => {
    const events: string[] = [];
    const auditEvents: AgentSystemAuditEvent[] = [];
    const runtime = createRuntime({ auditEvents, events });
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return { async dispose() {} };
      },
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

  it('should merge resource environment, redact resource secrets, and dispose before success', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const events: string[] = [];
    const logs: string[] = [];
    const requests: AgentSystemCliRunRequest[] = [];
    const runtime = createRuntime({
      auditEvents,
      events,
      logs,
      runCli: async (request) => {
        requests.push(request);
        events.push('run');
        return {
          exitCode: 0,
          stderr: 'lease-secret on stderr',
          stdout: 'lease-secret on stdout',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const definition = createToolTestDefinition({
      acquireResources(input, configuration, scope) {
        events.push('acquire');
        assert.equal(input.argument, 'status');
        assert.equal(configuration.token, 'AGENT_TOKEN');
        assert.equal(scope.agentId, 'data');
        assert.equal(scope.source, 'command');
        assert.equal(scope.workspaceDir, toolTestWorkspaceDir);
        return {
          async dispose() {
            events.push('dispose');
          },
          environment: { SSH_AUTH_SOCK: '/private/socket' },
          sensitiveValues: ['lease-secret'],
        };
      },
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

    assert.equal(requests[0]?.environment.SSH_AUTH_SOCK, '/private/socket');
    assert.equal(result.commandResult.stderr, '[REDACTED] on stderr');
    assert.equal(result.commandResult.stdout, '[REDACTED] on stdout');
    assert.equal(result.output, '[REDACTED] on stdout');
    assert.deepEqual(events, [
      'authorize',
      'audit:pending',
      'environment',
      'acquire',
      'run',
      'dispose',
      'audit:completed',
    ]);
    assert.equal(JSON.stringify(auditEvents).includes('lease-secret'), false);
    assert.equal(logs.join('\n').includes('lease-secret'), false);
  });

  it('should dispose resources before completing a nonzero child result', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const events: string[] = [];
    const runtime = createRuntime({
      auditEvents,
      events,
      runCli: async () => {
        events.push('run');
        return {
          exitCode: 2,
          stderr: 'command failed',
          stdout: '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return {
          async dispose() {
            events.push('dispose');
          },
        };
      },
    });

    const result = await runtime.executeCli(
      definition,
      { argument: 'status' },
      { agentId: 'data', source: 'command' },
    );

    assert.equal(result.commandResult.exitCode, 2);
    assert.deepEqual(
      auditEvents.map(({ phase, status }) => ({ phase, status })),
      [
        { phase: 'pending', status: undefined },
        { phase: 'completed', status: 'exit-2' },
      ],
    );
    assert.deepEqual(events.slice(-3), ['run', 'dispose', 'audit:completed']);
  });

  it('should dispose resources when preflight validation fails', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const events: string[] = [];
    const runtime = createRuntime({
      auditEvents,
      events,
      runCli: async () => {
        events.push('run');
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'unexpected',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return {
          async dispose() {
            events.push('dispose');
          },
        };
      },
    });
    definition.runner.preflight = () => ({
      argv: ['identity'],
      validate() {
        throw new AgentSystemToolError('tool_identity_mismatch', 'The identity did not match.');
      },
    });

    await assert.rejects(
      runtime.executeCli(
        definition,
        { argument: 'status' },
        { agentId: 'data', source: 'command' },
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'tool_identity_mismatch',
    );
    assert.deepEqual(events.slice(-3), ['run', 'dispose', 'audit:failed']);
    assert.equal(auditEvents.at(-1)?.status, 'tool_identity_mismatch');
  });

  it('should dispose resources when execution times out', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const events: string[] = [];
    const runtime = createRuntime({
      auditEvents,
      events,
      runCli: async () => {
        events.push('run');
        return {
          exitCode: null,
          stderr: '',
          stdout: '',
          timedOut: true,
          truncated: false,
        };
      },
    });
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return {
          async dispose() {
            events.push('dispose');
          },
        };
      },
    });

    await assert.rejects(
      runtime.executeCli(
        definition,
        { argument: 'status' },
        { agentId: 'data', source: 'command' },
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'execution_timed_out',
    );
    assert.deepEqual(events.slice(-3), ['run', 'dispose', 'audit:failed']);
    assert.equal(auditEvents.at(-1)?.status, 'execution_timed_out');
  });

  it('should dispose resources when execution is cancelled', async () => {
    const events: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const runtime = createRuntime({
      events,
      runCli: async (request) => {
        events.push('run');
        assert.equal(request.signal, controller.signal);
        assert.equal(request.signal?.aborted, true);
        return {
          exitCode: null,
          stderr: '',
          stdout: '',
          timedOut: false,
          truncated: false,
        };
      },
    });
    const definition = createToolTestDefinition({
      acquireResources(_input, _configuration, scope) {
        events.push('acquire');
        assert.equal(scope.signal, controller.signal);
        return {
          async dispose() {
            events.push('dispose');
          },
        };
      },
    });

    const result = await runtime.executeCli(
      definition,
      { argument: 'status' },
      { agentId: 'data', source: 'command' },
      controller.signal,
    );
    assert.equal(result.commandResult.exitCode, null);
    assert.deepEqual(events.slice(-3), ['run', 'dispose', 'audit:completed']);
  });

  it('should dispose resources when output normalization fails', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const events: string[] = [];
    const runtime = createRuntime({ auditEvents, events });
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return {
          async dispose() {
            events.push('dispose');
          },
        };
      },
    });
    definition.tool.normalize = () => {
      throw new Error('normalization failed');
    };

    await assert.rejects(
      runtime.executeCli(
        definition,
        { argument: 'status' },
        { agentId: 'data', source: 'command' },
      ),
      (error: unknown) =>
        error instanceof AgentSystemToolError && error.code === 'execution_failed',
    );
    assert.deepEqual(events.slice(-3), ['run', 'dispose', 'audit:failed']);
    assert.equal(auditEvents.at(-1)?.status, 'execution_failed');
  });

  it('should report resource cleanup failure without retrying disposal', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const events: string[] = [];
    let disposalCalls = 0;
    const runtime = createRuntime({ auditEvents, events });
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return {
          async dispose() {
            disposalCalls += 1;
            events.push('dispose');
            throw new Error('cleanup exposed lease-secret');
          },
          sensitiveValues: ['lease-secret'],
        };
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
        error.code === 'resource_cleanup_failed' &&
        !error.message.includes('lease-secret'),
    );
    assert.equal(disposalCalls, 1);
    assert.deepEqual(events.slice(-3), ['run', 'dispose', 'audit:failed']);
    assert.equal(auditEvents.at(-1)?.status, 'resource_cleanup_failed');
  });

  it('should report a stable error and failed audit when the executable is unavailable', async () => {
    const auditEvents: AgentSystemAuditEvent[] = [];
    const events: string[] = [];
    const logs: string[] = [];
    const runtime = createRuntime({
      auditEvents,
      events,
      logs,
      async runCli() {
        events.push('run');
        throw new Error('runner exposed private-token');
      },
    });
    const definition = createToolTestDefinition({
      acquireResources() {
        events.push('acquire');
        return {
          async dispose() {
            events.push('dispose');
          },
        };
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
    assert.deepEqual(events.slice(-3), ['run', 'dispose', 'audit:failed']);
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
