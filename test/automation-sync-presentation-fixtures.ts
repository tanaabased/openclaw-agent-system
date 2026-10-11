import { AutomationError } from '../agent/automation-gateway.ts';
import automationGatewayDiagnostic from '../agent/automation-gateway-diagnostic.ts';
import automationSync from '../cli/automation-sync.ts';
import { createCliStyles } from '../cli/output.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleReconcileResult,
} from '../core/lifecycle-registry.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

export const syncFixtureAgent = 'Agent-MixedCase';
export const syncFixtureWorkspace = '/Fixture/Workspace';
export const syncFixtureNames = [
  'changes',
  'drift-repaired',
  'unchanged',
  'empty',
  'attention',
  'unavailable-gateway',
  'partial-failure',
  'failed',
] as const;
type SyncFixtureName = (typeof syncFixtureNames)[number];

export function syncFixtureResult(
  name: SyncFixtureName,
): AgentSystemLifecycleReconcileResult | AgentSystemLifecycleError | Error {
  const outcomes: AgentSystemLifecycleReconcileResult['outcomes'] = [
    {
      component: 'automations',
      stepId: 'Review-MixedCase',
      code: 'automation-synchronized',
      status: 'created',
      message: 'Automation Review-MixedCase is synchronized (independent).',
    },
    {
      component: 'automations',
      stepId: 'Paused-Review',
      code: 'automation-synchronized',
      status: 'updated',
      message: 'Automation Paused-Review is synchronized (reused: Thread-MixedCase).',
    },
    {
      component: 'automations',
      stepId: 'Retired-Review',
      code: 'automation-disabled-retained',
      status: 'unchanged',
      message: 'Automation Retired-Review is disabled; ownership and native history are retained.',
    },
  ];
  const warning = {
    component: 'automations',
    code: 'automation-requires-operator-sync',
    message: 'Automation reconciliation requires operator openclaw agent-system install.',
  };
  if (name === 'changes') return { outcomes, warnings: [] };
  if (name === 'drift-repaired') return { outcomes: [outcomes[1]!], warnings: [] };
  if (name === 'unchanged')
    return {
      outcomes: [
        { ...outcomes[0]!, status: 'unchanged' },
        { ...outcomes[1]!, status: 'skipped' },
      ],
      warnings: [],
    };
  if (name === 'empty') return { outcomes: [], warnings: [] };
  if (name === 'attention') return { outcomes: [], warnings: [warning] };
  if (name === 'failed') return new Error('PrivateToken-MixedCase');
  const diagnostic = automationGatewayDiagnostic(
    name === 'partial-failure' ? 'cron.get' : 'cron.list',
    Object.assign(new Error('PrivateToken-MixedCase ws://PrivateHost:1234'), {
      name: 'GatewayTransportError',
      kind: 'closed',
      code: 1006,
      requestDispatched: false,
      connectionDetails: { token: 'PrivateToken-MixedCase' },
      details: { token: 'PrivateToken-MixedCase' },
    }),
  );
  const cause = new AutomationError('automation-gateway-unavailable', diagnostic);
  return new AgentSystemLifecycleError(
    'automations',
    cause.code,
    'PrivateToken-MixedCase',
    { cause },
    undefined,
    undefined,
    {
      outcomes: name === 'partial-failure' ? outcomes.slice(0, 2) : [],
      warnings: name === 'partial-failure' ? [warning] : [],
      unattempted: [{ component: 'automations' }],
    },
  );
}

export async function captureSyncFixture(
  name: SyncFixtureName,
  { json = false, columns = 120, color = false, warnings = false } = {},
) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const calls: Array<{ agentId: string; workspaceDir: string; options: unknown }> = [];
  let exitCode = 0;
  const result = syncFixtureResult(name);
  const loaded: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
    status: 'loaded',
    scope: { workspaceDir: syncFixtureWorkspace },
    path: syncFixtureWorkspace + '/agent.yaml',
    digest: 'fixture',
    manifest: { schemaVersion: 1, agent: { id: syncFixtureAgent } },
    diagnostics: warnings
      ? [
          {
            code: 'manifest-shadowed',
            severity: 'warning',
            message: 'External Warning: MixedCase.yaml is shadowed.',
          },
        ]
      : [],
    validationChecks: [],
  };
  const unused = async (): Promise<never> => {
    throw new Error('unexpected fixture operation');
  };
  await automationSync({
    agentId: syncFixtureAgent,
    json,
    manifestService: {
      async loadForAgentId() {
        return loaded;
      },
      loadForCommandDirectory: unused,
    },
    automations: {
      list: unused,
      run: unused,
      runs: unused,
      async reconcile(manifest, workspaceDir, options) {
        calls.push({ agentId: manifest.agent.id, workspaceDir, options });
        if (result instanceof Error) throw result;
        return result;
      },
    },
    output: {
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
    },
    setExitCode: (code) => {
      exitCode = code;
    },
    styles: createCliStyles(color ? { FORCE_COLOR: '3' } : { NO_COLOR: '', FORCE_COLOR: '3' }),
    terminalColumns: columns,
    workspaceDir: '/Ignored/Invoking-Workspace',
  });
  return { calls, events, exitCode, result };
}
