import automationRuns from '../cli/automation-runs.ts';
import { createCliStyles, type CliOutput } from '../cli/output.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

const entries = [
  { ts: 1_791_603_000_123, runId: 'run-older', execution: 'ok', delivery: 'delivered' },
  { ts: 1_791_603_060_456, runId: 'run-current', execution: 'error', delivery: 'not-delivered' },
];

export async function captureAutomationRuns(options: { columns: number; empty?: boolean }) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  const output: CliOutput = {
    writeStdout: (text) => events.push({ stream: 'stdout', text }),
    writeStderr: (text) => events.push({ stream: 'stderr', text }),
  };
  const manifest: Extract<AgentManifestLoadResult, { status: 'loaded' }> = {
    status: 'loaded',
    manifest: { schemaVersion: 1, agent: { id: 'Agent-Mixed' } },
    scope: { workspaceDir: '/Workspace/Mixed' },
    path: '/Workspace/Mixed/agent.yaml',
    digest: 'fixture',
    diagnostics: [],
    validationChecks: [],
  };
  await automationRuns(
    {
      automations: {
        runs: async () => ({
          status: 'ok',
          entries: options.empty ? [] : entries,
          total: options.empty ? 0 : 4,
          offset: options.empty ? 0 : 2,
          limit: 2,
          hasMore: !options.empty,
          nextOffset: options.empty ? null : 4,
        }),
      } as never,
      json: false,
      styles: createCliStyles({ NO_COLOR: '1' }),
      terminalColumns: options.columns,
      manifestService: {
        loadForCommandDirectory: async () => manifest,
      } as never,
      output,
      setExitCode: () => undefined,
      workspaceDir: '/Workspace/Mixed',
    },
    'review',
    { limit: 2, offset: 2, runId: options.empty ? 'run-missing' : undefined },
  );
  return events;
}
