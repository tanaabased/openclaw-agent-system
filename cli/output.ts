import ansis, { Ansis } from 'ansis';
import { defaultRuntime, type OutputRuntimeEnv } from 'openclaw/plugin-sdk/runtime';

export type CliOutput = Pick<OutputRuntimeEnv, 'writeStdout'> & {
  writeStderr(value: string): void;
};

export interface CliStyles {
  action(value: string): string;
  error(value: string): string;
  field(value: string): string;
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
    error: (value) => color.bold(color.red(value)),
    field: (value) => color.dim(value),
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
