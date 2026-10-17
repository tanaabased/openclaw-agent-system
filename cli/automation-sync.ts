import { AutomationError } from '../agent/automation-gateway.ts';
import { lifecycleTableLines } from '../core/lifecycle-presentation.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import { formatRedactedErrorDiagnostic } from '../core/logger.ts';
import type { AutomationCommandOptions } from './automation-output.ts';
import loadCommandManifest from './load-command-manifest.ts';
import {
  type CliLifecycleLine,
  renderCliLifecycleTable,
  renderCliSummary,
  writeCliDiagnosticNotices,
  writeCliJson,
  writeCliLines,
} from './output.ts';
import presentCliCommand from './presentation.ts';

function syncTable(
  options: AutomationCommandOptions,
  agentId: string,
  workspaceDir: string,
  status: 'synchronized' | 'attention' | 'failed',
  lines: CliLifecycleLine[],
) {
  const summary = renderCliSummary(
    [
      { label: 'agent', style: 'target', value: agentId },
      { label: 'runtime', style: 'field', value: 'openclaw' },
      {
        label: 'sync',
        style: status === 'failed' ? 'error' : status === 'attention' ? 'warning' : 'status',
        value: status,
      },
    ],
    options.styles,
    { rowPadding: 0, terminalColumns: options.terminalColumns },
  );
  const table = renderCliLifecycleTable(
    lines,
    workspaceDir,
    options.styles,
    options.terminalColumns,
    { rowPadding: 1 },
  );
  writeCliLines(options.output, ['', ...summary, ...table]);
}

/** retain strict synchronization semantics while presenting reported progress. */
async function automationSync(options: AutomationCommandOptions) {
  const loaded = await loadCommandManifest(options);
  if (!loaded) return;
  const { manifest, scope } = loaded;
  try {
    const reconciled = await options.automations.reconcile(manifest, scope.workspaceDir);
    const result = { runtime: 'openclaw', status: 'synchronized', ...reconciled };
    if (options.json) {
      writeCliJson(options.output, result);
      return;
    }
    syncTable(
      options,
      manifest.agent.id,
      scope.workspaceDir,
      result.warnings.length ? 'attention' : 'synchronized',
      lifecycleTableLines(
        result.outcomes.length
          ? result.outcomes.map((outcome) => ({
              ...outcome,
              component: outcome.stepId
                ? `${outcome.component}/${outcome.stepId}`
                : outcome.component,
            }))
          : [
              {
                component: 'automations',
                status: result.warnings.length ? 'warning' : 'unchanged',
                message: result.warnings.length
                  ? 'no completed automation outcomes were reported; see messages.'
                  : 'no applicable automation work; already aligned.',
              },
            ],
      ),
    );
    writeCliDiagnosticNotices(
      options,
      result.warnings.map(({ code, message }) => ({
        severity: 'warning',
        message: `${message} code=${code}`,
      })),
    );
  } catch (error) {
    const code =
      error instanceof AutomationError || error instanceof AgentSystemLifecycleError
        ? error.code
        : 'automation-operation-failed';
    const failure = error instanceof AgentSystemLifecycleError ? error.cause : error;
    const diagnostic = failure instanceof AutomationError ? failure.diagnostic : undefined;
    const progress = error instanceof AgentSystemLifecycleError ? error.progress : undefined;
    const result = {
      status: 'failed',
      code,
      ...(diagnostic ? { diagnostic } : {}),
      ...(progress ? { progress } : {}),
    };
    if (options.json) writeCliJson(options.output, result);
    else {
      const outcomes = lifecycleTableLines(
        (progress?.outcomes ?? []).map((outcome) => ({
          ...outcome,
          component: outcome.stepId ? `${outcome.component}/${outcome.stepId}` : outcome.component,
        })),
      );
      const pending: CliLifecycleLine[] = (progress?.unattempted ?? []).map(
        ({ component, stepId }) => ({
          component: stepId ? `${component}/${stepId}` : component,
          label: 'pending',
          style: 'field',
          quiet: true,
          attention: false,
          value: 'remaining reconciliation work was not completed.',
        }),
      );
      syncTable(options, manifest.agent.id, scope.workspaceDir, 'failed', [
        ...outcomes,
        ...pending,
        ...(!outcomes.length && !pending.length
          ? lifecycleTableLines([
              {
                component: 'automations',
                status: 'blocked',
                message: 'no completed progress was reported; see messages.',
              },
            ])
          : []),
      ]);
    }
    writeCliDiagnosticNotices(options, [
      {
        severity: 'error',
        message:
          failure instanceof AutomationError || failure === undefined
            ? `automation operation stopped (${code}).`
            : formatRedactedErrorDiagnostic('automations', failure, code),
      },
      ...(progress
        ? [
            {
              severity: 'warning' as const,
              message: options.json
                ? `partial progress: completed=${progress.outcomes.length} warnings=${progress.warnings.length} unattempted=${progress.unattempted.length}; ${progress.outcomes.length > 0 ? 'completed changes remain applied' : 'no completed changes reported'}; the stopped operation may have partial effects.`
                : `${progress.outcomes.length > 0 ? 'completed changes remain applied; ' : ''}the stopped operation may have partial effects.`,
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
      ...(!options.json
        ? [
            ...(progress?.warnings ?? []).map(({ code, message }) => ({
              severity: 'warning' as const,
              message: `${message} code=${code}`,
            })),
            {
              severity: 'notice' as const,
              message:
                code === 'automation-gateway-unavailable'
                  ? 'restore gateway connectivity before rerunning openclaw agent-system automations sync.'
                  : 'resolve the reported cause before rerunning openclaw agent-system automations sync.',
            },
          ]
        : []),
    ]);
    options.setExitCode(1);
  }
}

export default presentCliCommand(automationSync);
