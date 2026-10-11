import presentCliCommand from './presentation.ts';
import type AutomationService from '../agent/automation-service.ts';
import { AutomationError } from '../agent/automation-gateway.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleFinding,
} from '../core/lifecycle-registry.ts';
import loadCommandManifest from './load-command-manifest.ts';
import type AgentManifestService from '../manifest/service.ts';
import type { AgentManifest } from '../manifest/types.ts';
import {
  type CliOutput,
  type CliStyles,
  renderCliSummary,
  renderCliTableRows,
  writeCliDiagnosticNotices,
  writeCliLines,
  writeCliJson,
} from './output.ts';

export interface AutomationCommandOptions {
  agentId?: string;
  automations: Pick<AutomationService, 'list' | 'reconcile' | 'run' | 'runs'>;
  json: boolean;
  styles?: CliStyles;
  terminalColumns?: number;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  output: CliOutput;
  setExitCode(code: number): void;
  workspaceDir: string;
}

/** keep operator results bounded and diagnostics separate from primary output. */
async function automationOperation(
  options: AutomationCommandOptions,
  operation: (manifest: AgentManifest, workspace: string) => Promise<Record<string, unknown>>,
  history?: { id: string; runId?: string },
) {
  const loaded = await loadCommandManifest(options);
  if (!loaded) return;
  try {
    const result = await operation(loaded.manifest, loaded.scope.workspaceDir);
    if (options.json) writeCliJson(options.output, result);
    else if (history) {
      const styles = options.styles;
      const entries = (result.entries ?? []) as Record<string, unknown>[];
      const rows = [
        { cells: ['run id', 'time', 'execution', 'delivery'].map((value) => ({ value })) },
        ...entries.map(({ runId, ts, execution, delivery }) => ({
          cells: [
            { value: typeof runId === 'string' ? runId : 'unavailable', style: 'action' as const },
            { value: new Date(Number(ts)).toISOString() },
            {
              value: String(execution),
              style:
                execution === 'ok'
                  ? ('status' as const)
                  : execution === 'error'
                    ? ('error' as const)
                    : ('field' as const),
            },
            {
              value: String(delivery),
              style:
                delivery === 'delivered'
                  ? ('status' as const)
                  : delivery === 'not-delivered'
                    ? ('warning' as const)
                    : ('field' as const),
            },
          ],
        })),
      ];
      const query = `limit=${result.limit}  offset=${result.offset}  run-id=${history.runId ?? 'all'}`;
      const columns = options.terminalColumns ?? process.stdout.columns;
      writeCliLines(options.output, [
        `${styles?.bold('automation') ?? 'automation'}  ${styles?.target(history.id) ?? history.id}`,
        ...renderCliSummary(
          [
            { label: 'query', style: 'field', value: query },
            { label: 'runs', style: 'field', value: `${entries.length} of ${result.total}` },
          ],
          styles,
          { rowPadding: 0, terminalColumns: columns },
        ),
        '',
        ...renderCliTableRows(rows, styles, {
          rowPadding: 0,
          terminalColumns: columns,
        }),
        '',
        ...(entries.length === 0 ? ['no matching runs'] : []),
        ...(result.hasMore ? [`next page: --offset ${result.nextOffset}`] : []),
      ]);
    } else {
      const rows = (result.jobs ?? result.outcomes ?? result.entries ?? []) as Record<
        string,
        unknown
      >[];
      options.output.writeStdout(`${result.status}\n`);
      for (const row of rows) {
        const findings = row.findings as { code: string }[] | undefined;
        const fields = [
          row.id ?? row.stepId ?? row.runId ?? row.ts,
          row.status ?? findings?.map(({ code }) => code).join(', '),
          row.nativeId,
          row.execution && `execution=${row.execution}`,
          row.delivery && `delivery=${row.delivery}`,
        ].filter((field) => field !== undefined && field !== false);
        options.output.writeStdout(`${fields.join('  ')}\n`);
      }
      for (const finding of (result.findings ?? []) as AgentSystemLifecycleFinding[]) {
        if (!rows.some(({ id }) => id === finding.stepId))
          options.output.writeStdout(`${finding.stepId}  ${finding.status}  ${finding.code}\n`);
      }
      if (result.runId)
        options.output.writeStdout(
          `run=${result.runId}  execution=${result.execution}  delivery=${result.delivery}\n`,
        );
      if (result.reason)
        writeCliDiagnosticNotices(options, [
          {
            severity:
              result.reason === 'invalid-spec'
                ? 'error'
                : result.reason === 'stopped'
                  ? 'warning'
                  : 'notice',
            message: `reason=${result.reason}`,
          },
        ]);
      if (result.hasMore) options.output.writeStdout(`next-offset=${result.nextOffset}\n`);
    }
    if (result.status === 'attention' || result.status === 'skipped') options.setExitCode(1);
  } catch (error) {
    const code =
      error instanceof AutomationError || error instanceof AgentSystemLifecycleError
        ? error.code
        : 'automation-operation-failed';
    const failure = error instanceof AgentSystemLifecycleError ? error.cause : error;
    const diagnostic = failure instanceof AutomationError ? failure.diagnostic : undefined;
    const result = {
      status: 'failed',
      code,
      ...(diagnostic ? { diagnostic } : {}),
      ...(error instanceof AgentSystemLifecycleError && error.progress
        ? { progress: error.progress }
        : {}),
    };
    if (options.json) writeCliJson(options.output, result);
    writeCliDiagnosticNotices(options, [
      { severity: 'error', message: `automation operation stopped (${code}).` },
      ...(error instanceof AgentSystemLifecycleError && error.progress
        ? [
            {
              severity: 'warning' as const,
              message: `partial progress: completed=${error.progress.outcomes.length} warnings=${error.progress.warnings.length} unattempted=${error.progress.unattempted.length}; ${error.progress.outcomes.length > 0 ? 'completed changes remain applied' : 'no completed changes reported'}; the stopped operation may have partial effects.`,
            },
          ]
        : []),
      ...(diagnostic
        ? [
            {
              severity: 'error' as const,
              message: `gateway diagnostic: ${JSON.stringify(diagnostic)}`,
            },
          ]
        : []),
    ]);
    options.setExitCode(1);
  }
}

export default presentCliCommand(automationOperation);
