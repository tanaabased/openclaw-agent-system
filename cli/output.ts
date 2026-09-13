import ansis, { Ansis } from 'ansis';
import stringWidth from 'fast-string-width';
import { wrapAnsi } from 'fast-wrap-ansi';
import { defaultRuntime, type OutputRuntimeEnv } from 'openclaw/plugin-sdk/runtime';

export type CliOutput = Pick<OutputRuntimeEnv, 'writeStdout'> & {
  writeStderr(value: string): void;
};

export interface CliStyles {
  action(value: string): string;
  bold(value: string): string;
  error(value: string): string;
  field(value: string): string;
  notice(value: string): string;
  status(value: string): string;
  target(value: string): string;
  warning(value: string): string;
}

export interface CliSummaryLine {
  component?: string;
  label: string;
  style: 'action' | 'error' | 'field' | 'status' | 'target' | 'warning';
  value: string;
}

export interface CliLifecycleLine extends CliSummaryLine {
  component: string;
  attention: boolean;
  quiet: boolean;
}

function colorLevel(environment: NodeJS.ProcessEnv): number {
  if (Object.hasOwn(environment, 'NO_COLOR')) return 0;
  if (!Object.hasOwn(environment, 'FORCE_COLOR')) return ansis.level;

  const value = environment.FORCE_COLOR?.trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return 0;
  if (value === '2' || value === '3') return Number(value);
  return 1;
}

export function createCliStyles(environment: NodeJS.ProcessEnv = process.env): CliStyles {
  const color = new Ansis(colorLevel(environment)).extend({
    tp: '#00c88a',
    ts: '#db2777',
  });

  return {
    action: (value) => color.tp(value),
    bold: (value) => color.bold(value),
    error: (value) => color.bold(color.red(value)),
    field: (value) => color.dim(value),
    notice: (value) => color.bold(color.cyan(value)),
    status: (value) => color.bold(color.green(value)),
    target: (value) => color.ts(value),
    warning: (value) => color.bold(color.yellow(value)),
  };
}

const defaultCliStyles = createCliStyles();

export function renderCliSummary(
  lines: readonly CliSummaryLine[],
  styles: CliStyles = defaultCliStyles,
): string[] {
  const labelWidth = Math.max(0, ...lines.map(({ label }) => label.length)) + 2;
  const componentWidth = Math.max(0, ...lines.map(({ component }) => component?.length ?? 0));
  return lines.map(({ component, label, style, value }) => {
    const formattedLabel = label.padEnd(labelWidth);
    const formattedComponent =
      componentWidth === 0 ? '' : `${(component ?? '').padEnd(componentWidth)}  `;
    const prefix = `${formattedLabel}${formattedComponent}`;
    if (style === 'action') return `${styles.action(prefix)}${styles.target(value)}`;
    if (style === 'error') return `${styles.error(prefix)}${value}`;
    if (style === 'status') return `${styles.status(prefix)}${styles.target(value)}`;
    if (style === 'target') return `${styles.field(prefix)}${styles.target(value)}`;
    if (style === 'warning') return `${styles.warning(prefix)}${value}`;
    return `${styles.field(prefix)}${value}`;
  });
}

export function writeCliLines(output: CliOutput, lines: readonly string[]): void {
  if (lines.length === 0) return;
  output.writeStdout(`${lines.join('\n')}\n`);
}

export function writeCliSummary(
  output: CliOutput,
  lines: readonly CliSummaryLine[],
  styles?: CliStyles,
): void {
  writeCliLines(output, renderCliSummary(lines, styles));
}

/** Render Doctor and Install without changing other summary callers. */
export function renderCliLifecycleTable(
  lines: readonly CliLifecycleLine[],
  workspaceDir: string,
  styles: CliStyles = defaultCliStyles,
  terminalColumns = 80,
): string[] {
  const columns =
    Number.isFinite(terminalColumns) && terminalColumns >= 1 ? Math.floor(terminalColumns) : 80;
  const componentWidth = Math.max(0, ...lines.map(({ component }) => stringWidth(component)));
  const labelWidth = Math.max(0, ...lines.map(({ label }) => stringWidth(label)));
  const prefixWidth = componentWidth + labelWidth + 4;
  const stacked = columns - prefixWidth < 24;
  const indent = ' '.repeat(stacked ? Math.min(2, columns - 1) : prefixWidth);
  const explanationWidth = columns - indent.length;
  const rows = lines.flatMap(({ attention, component, label, quiet, style, value }) => {
    const name = attention ? styles.bold(component) : component;
    const status =
      style === 'action' || style === 'error' || style === 'status' || style === 'warning'
        ? styles[style](label)
        : attention
          ? styles.bold(label)
          : label;
    const gap = ' '.repeat(componentWidth - stringWidth(component) + 2);
    const header = `${name}${gap}${status}`;
    const explanation = wrapAnsi(value, explanationWidth, { hard: true })
      .split('\n')
      .map((line) => (quiet ? styles.field(line) : line));
    if (stacked) {
      const compactHeader =
        componentWidth + labelWidth + 2 > columns ? `${name}  ${status}` : header;
      return [
        ...wrapAnsi(compactHeader, columns, { hard: true }).split('\n'),
        ...explanation.map((line) => `${indent}${line}`),
      ];
    }
    const statusGap = ' '.repeat(labelWidth - stringWidth(label) + 2);
    return explanation.map((line, index) =>
      index === 0 ? `${header}${statusGap}${line}` : `${indent}${line}`,
    );
  });
  return [...rows, ...(rows.length ? [''] : []), `workspace  ${styles.bold(workspaceDir)}`];
}

export function writeCliLifecycleTable(
  output: CliOutput,
  lines: readonly CliLifecycleLine[],
  workspaceDir: string,
  styles?: CliStyles,
  terminalColumns?: number,
): void {
  writeCliLines(output, renderCliLifecycleTable(lines, workspaceDir, styles, terminalColumns));
}

export interface CliNotice {
  message: string;
  severity: 'notice' | 'warning';
}

/** Render completed install notices after the lifecycle table without dimming their guidance. */
export function renderCliNotices(
  notices: readonly CliNotice[],
  styles: CliStyles = defaultCliStyles,
  terminalColumns = 80,
): string[] {
  if (notices.length === 0) return [];
  const columns =
    Number.isFinite(terminalColumns) && terminalColumns >= 1 ? Math.floor(terminalColumns) : 80;
  const indent = '  ';
  const messageWidth = Math.max(1, columns - indent.length);
  const blocks = notices.flatMap(({ message, severity }) => {
    const label = severity === 'notice' ? 'ℹ Notice' : '⚠ Warning';
    const styledLabel = severity === 'notice' ? styles.notice(label) : styles.warning(label);
    return [
      styledLabel,
      ...wrapAnsi(message, messageWidth, { hard: true }).split('\n').map((line) => `${indent}${line}`),
    ];
  });
  return ['', styles.bold('Notices'), '', ...blocks];
}

export function writeCliNotices(
  output: CliOutput,
  notices: readonly CliNotice[],
  styles?: CliStyles,
  terminalColumns?: number,
): void {
  writeCliLines(output, renderCliNotices(notices, styles, terminalColumns));
}

export function writeCliJson(output: CliOutput, value: unknown): void {
  output.writeStdout(`${JSON.stringify(value, undefined, 2)}\n`);
}

export function writeCliDiagnostics(output: CliOutput, messages: readonly string[]): void {
  if (messages.length === 0) return;
  output.writeStderr(`${messages.join('\n')}\n`);
}

export function writeCliError(output: CliOutput, message: string): void {
  writeCliDiagnostics(output, [message]);
}

export const defaultCliOutput: CliOutput = {
  writeStderr: (value) => process.stderr.write(value),
  writeStdout: (value) => defaultRuntime.writeStdout(value),
};
