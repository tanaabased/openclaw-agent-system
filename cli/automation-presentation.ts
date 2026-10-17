import type AutomationService from '../agent/automation-service.ts';
import type { AgentSystemLifecycleFinding } from '../core/lifecycle-registry.ts';
import {
  type CliLifecycleLine,
  type CliStyles,
  renderCliLifecycleTable,
  renderCliSummary,
} from './output.ts';

type AutomationJob = Awaited<ReturnType<AutomationService['list']>>['jobs'][number];

function stateLine(component: string, label: string, value: string): CliLifecycleLine {
  const attention = ['blocked', 'drift', 'warning', 'manual', 'error', 'not-delivered'].includes(
    label,
  );
  return {
    component,
    label,
    value,
    attention,
    quiet: !attention,
    style:
      label === 'manual'
        ? 'field'
        : label === 'blocked' || label === 'error'
          ? 'error'
          : attention
            ? 'warning'
            : ['created', 'updated', 'queued'].includes(label)
              ? 'action'
              : ['aligned', 'healthy', 'ok', 'unchanged'].includes(label)
                ? 'status'
                : 'field',
  };
}

function findingDetails(findings: readonly AgentSystemLifecycleFinding[]): string {
  return findings
    .map(({ code, message, status }) =>
      status === 'healthy' || status === 'skipped' ? code : `${code}: ${message}`,
    )
    .join('; ');
}

function jobLine(job: AutomationJob): CliLifecycleLine {
  const attention = ['blocked', 'drift', 'warning', 'manual']
    .map((status) => job.findings.find((finding) => finding.status === status))
    .find(Boolean);
  const label = attention
    ? attention.status
    : !job.applicable
      ? 'inapplicable'
      : !job.declared || job.removed
        ? 'retained'
        : !job.enabled
          ? 'disabled'
          : job.findings.some(({ code }) => code === 'automation-completed')
            ? 'completed'
            : job.findings.some(({ status }) => status === 'healthy')
              ? 'aligned'
              : 'unavailable';
  const missing = job.findings.some(({ code }) =>
    ['automation-missing', 'automation-recovery-required'].includes(code),
  );
  const native =
    job.nativeEnabled === null
      ? missing
        ? 'missing'
        : 'unavailable'
      : job.nativeEnabled
        ? 'enabled'
        : 'disabled';
  const details = [
    `declared=${job.declared ? 'yes' : 'no'}`,
    `desired=${job.enabled ? 'enabled' : 'disabled'}`,
    `applicable=${job.applicable ? 'yes' : 'no'}`,
    `native=${native}`,
    ...(job.nativeId ? [`native-id=${job.nativeId}`] : []),
    `routing=${job.routing}`,
    `execution=${job.execution}`,
    `delivery=${job.delivery}`,
    findingDetails(job.findings),
  ]
    .filter(Boolean)
    .join('  ');
  return stateLine(job.id, label, details);
}

/** render normalized results only; findings, not enabled-state comparisons, establish drift. */
export default function automationPresentation(
  result: Record<string, unknown>,
  workspaceDir: string,
  styles: CliStyles,
  terminalColumns: number,
): string[] {
  const jobs = result.jobs as AutomationJob[] | undefined;
  const records = (result.outcomes ?? result.entries ?? []) as Record<string, unknown>[];
  const rows = jobs
    ? jobs.map(jobLine)
    : records.map((row) =>
        stateLine(
          String(row.stepId ?? result.id ?? row.runId ?? row.ts ?? row.component),
          String(row.status ?? row.execution ?? 'unavailable'),
          [
            row.runId !== undefined && `run=${row.runId}`,
            row.ts !== undefined && `ts=${row.ts}`,
            row.execution !== undefined && `execution=${row.execution}`,
            row.delivery !== undefined && `delivery=${row.delivery}`,
            row.code,
            row.message,
          ]
            .filter((field) => field !== undefined && field !== false)
            .join('  '),
        ),
      );
  if (!jobs && result.id && !result.entries) {
    rows.push(
      stateLine(
        String(result.id),
        String(result.status),
        [
          result.nativeId && `native-id=${result.nativeId}`,
          result.runId && `run=${result.runId}`,
          result.reason && `reason=${result.reason}`,
          result.execution && `execution=${result.execution}`,
          result.delivery && `delivery=${result.delivery}`,
        ]
          .filter(Boolean)
          .join('  '),
      ),
    );
  }
  for (const finding of (result.findings ?? []) as AgentSystemLifecycleFinding[]) {
    if (!jobs?.some(({ id }) => id === finding.stepId))
      rows.push(
        stateLine(finding.stepId ?? finding.component, finding.status, findingDetails([finding])),
      );
  }
  const empty =
    jobs && !jobs.length
      ? 'no automations declared or retained'
      : result.entries && !records.length
        ? 'no automation runs'
        : result.outcomes && !records.length
          ? 'no automation changes'
          : undefined;
  const context = [
    { label: 'runtime', style: 'field' as const, value: String(result.runtime ?? 'openclaw') },
    { label: 'result', style: 'field' as const, value: String(result.status) },
    ...(result.entries
      ? [
          {
            label: 'automation',
            style: 'field' as const,
            value: `${result.id}  native-id=${result.nativeId}  total=${result.total}  offset=${result.offset}  limit=${result.limit}`,
          },
        ]
      : []),
    ...(result.hasMore
      ? [{ label: 'next-offset', style: 'field' as const, value: String(result.nextOffset) }]
      : []),
  ];
  return [
    '',
    ...renderCliSummary(context, styles, { rowPadding: 0, terminalColumns }),
    ...renderCliLifecycleTable(
      [
        ...(rows.length
          ? [
              {
                component: 'automation id',
                label: 'state',
                value: 'desired / observed / activity',
                attention: true,
                quiet: false,
                style: 'field' as const,
              },
            ]
          : []),
        ...rows.map((row) => ({
          ...row,
          component:
            row.quiet && row.style === 'field' ? styles.field(row.component) : row.component,
        })),
        ...(empty ? [stateLine('automations', 'empty', empty)] : []),
      ],
      String(result.workspaceDir ?? workspaceDir),
      styles,
      terminalColumns,
      { rowPadding: 0 },
    ),
  ];
}
