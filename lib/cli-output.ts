import ansis, { Ansis } from 'ansis';
import { defaultRuntime, type OutputRuntimeEnv } from 'openclaw/plugin-sdk/runtime';

export type CliOutput = Pick<OutputRuntimeEnv, 'writeStdout'> & {
  writeStderr?(value: string): void;
};

export interface CliStyles {
  action(value: string): string;
  field(value: string): string;
  status(value: string): string;
  target(value: string): string;
}

export interface CliSummaryLine {
  label: string;
  style: 'action' | 'field' | 'status' | 'target';
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
    field: (value) => color.dim(value),
    status: (value) => color.bold(color.green(value)),
    target: (value) => color.ts(value),
  };
}

const defaultCliStyles = createCliStyles();

export function renderCliSummary(
  lines: readonly CliSummaryLine[],
  styles: CliStyles = defaultCliStyles,
): string[] {
  const width = Math.max(0, ...lines.map(({ label }) => label.length)) + 2;
  return lines.map(({ label, style, value }) => {
    const formattedLabel = label.padEnd(width);
    if (style === 'action') return `${styles.action(formattedLabel)}${styles.target(value)}`;
    if (style === 'status') return `${styles.status(formattedLabel)}${styles.target(value)}`;
    if (style === 'target') return `${styles.field(formattedLabel)}${styles.target(value)}`;
    return `${styles.field(formattedLabel)}${value}`;
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

export const defaultCliOutput: CliOutput = {
  writeStderr: (value) => process.stderr.write(value),
  writeStdout: (value) => defaultRuntime.writeStdout(value),
};
