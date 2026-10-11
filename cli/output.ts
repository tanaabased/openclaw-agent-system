import ansis, { Ansis } from 'ansis';
import stringWidth from 'fast-string-width';
import { wrapAnsi } from 'fast-wrap-ansi';
import { defaultRuntime, type OutputRuntimeEnv } from 'openclaw/plugin-sdk/runtime';

export type CliOutput = Pick<OutputRuntimeEnv, 'writeStdout'> & {
  writeStderr(value: string): void;
  collectNotices?(notices: readonly CliNotice[]): void;
};

export interface CliStyles {
  accent(value: string): string;
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
  quiet?: boolean;
  label: string;
  style: 'action' | 'error' | 'field' | 'notice' | 'status' | 'target' | 'warning';
  value: string;
  valueStyle?: keyof CliStyles;
}

export interface CliLifecycleLine extends CliSummaryLine {
  component: string;
  attention: boolean;
  quiet: boolean;
}

// brand hues come from tanaab/theme; semantic colors follow the terminal palette.
export const cliPalette = {
  tp: '#00c88a',
  ts: '#db2777',
  brightPink: '#e25292',
};

function colorLevel(environment: NodeJS.ProcessEnv): number {
  if (Object.hasOwn(environment, 'NO_COLOR')) return 0;
  if (!Object.hasOwn(environment, 'FORCE_COLOR')) return ansis.level;

  const value = environment.FORCE_COLOR?.trim().toLowerCase();
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return 0;
  if (value === '2' || value === '3') return Number(value);
  return 1;
}

export function createCliStyles(environment: NodeJS.ProcessEnv = process.env): CliStyles {
  const color = new Ansis(colorLevel(environment)).extend(cliPalette);

  return {
    accent: (value) => color.brightPink(value),
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

export interface CliTableOptions {
  rowPadding?: 0 | 1;
  terminalColumns?: number;
}

export interface CliTableCell {
  value: string;
  style?: keyof CliStyles;
}

export interface CliTableRow {
  cells: CliTableCell[];
}

interface CliRenderedTableRow {
  cells: Array<{ value: string; style?: keyof CliStyles }>;
  value: string;
  quiet?: boolean;
  valueStyle?: keyof CliStyles;
}

/** share terminal-cell alignment and wrapping; padding separates rows, not wrapped lines. */
function renderCliTable(
  rows: readonly CliRenderedTableRow[],
  styles: CliStyles,
  { rowPadding = 0, terminalColumns = 80 }: CliTableOptions,
): string[] {
  const columns =
    Number.isFinite(terminalColumns) && terminalColumns >= 1 ? Math.floor(terminalColumns) : 80;
  const widths = Array.from(
    { length: Math.max(0, ...rows.map(({ cells }) => cells.length)) },
    (_, index) => Math.max(0, ...rows.map(({ cells }) => stringWidth(cells[index]?.value ?? ''))),
  );
  const prefixWidth = widths.reduce((sum, width) => sum + width + 2, 0);
  const stacked = columns - prefixWidth < 24;
  const indent = ' '.repeat(stacked ? Math.min(2, columns - 1) : prefixWidth);
  return rows.flatMap(({ cells, value, quiet, valueStyle }, index) => {
    const header = cells
      .map(
        ({ value, style }, cellIndex) =>
          `${style ? styles[style](value) : value}${' '.repeat(widths[cellIndex]! - stringWidth(value) + 2)}`,
      )
      .join('');
    const explanation = wrapAnsi(value, columns - indent.length, { hard: true })
      .split('\n')
      .map((line) => (valueStyle ? styles[valueStyle](line) : quiet ? styles.field(line) : line));
    const padding = index ? Array<string>(rowPadding).fill('') : [];
    if (stacked) {
      const compactHeader = cells
        .map(({ value, style }) => (style ? styles[style](value) : value))
        .join('  ');
      return [
        ...padding,
        ...wrapAnsi(compactHeader, columns, { hard: true }).split('\n'),
        ...explanation.map((line) => `${indent}${line}`),
      ];
    }
    return [
      ...padding,
      ...explanation.map((line, lineIndex) =>
        lineIndex === 0 ? `${header}${line}` : `${indent}${line}`,
      ),
    ];
  });
}

/** render a compact aligned table using the shared terminal-cell layout. */
export function renderCliTableRows(
  rows: readonly CliTableRow[],
  styles: CliStyles = defaultCliStyles,
  options: CliTableOptions = {},
): string[] {
  if (rows.length === 0) return [];
  const columns = Math.max(1, Math.floor(options.terminalColumns ?? 80));
  const count = Math.max(0, ...rows.map(({ cells }) => cells.length));
  const widths = Array.from({ length: count }, (_, index) =>
    Math.max(0, ...rows.map(({ cells }) => stringWidth(cells[index]?.value ?? ''))),
  );
  const wideEnough = widths.reduce((total, width) => total + width, 0) + count * 2 <= columns;
  const header = rows[0]!.cells;
  if (!wideEnough) {
    if (rows.length === 1) {
      return wrapAnsi(header.map(({ value }) => value).join('  '), columns, { hard: true }).split(
        '\n',
      );
    }
    return rows.slice(1).flatMap(({ cells }) =>
      cells.flatMap((cell, index) => {
        const label = header[index]?.value ?? '';
        const line = `${label}: ${cell.value}`;
        return wrapAnsi(line, columns, { hard: true })
          .split('\n')
          .map((part) => (cell.style ? styles[cell.style](part) : part));
      }),
    );
  }
  return rows.map(({ cells }) =>
    cells
      .map((cell, index) => {
        const value = cell.style ? styles[cell.style](cell.value) : cell.value;
        return `${value}${' '.repeat(widths[index]! - stringWidth(cell.value) + 2)}`;
      })
      .join('')
      .trimEnd(),
  );
}

export function renderCliSummary(
  lines: readonly CliSummaryLine[],
  styles: CliStyles = defaultCliStyles,
  options: CliTableOptions = {},
): string[] {
  const hasComponents = lines.some(({ component }) => component !== undefined);
  return renderCliTable(
    lines.map(({ component, label, quiet, style, value, valueStyle }) => ({
      cells: [
        { value: label, style: style === 'target' ? 'field' : style },
        ...(hasComponents ? [{ value: component ?? '' }] : []),
      ],
      valueStyle: valueStyle ?? (style === 'target' ? 'target' : undefined),
      quiet,
      value,
    })),
    styles,
    options,
  );
}

export function writeCliLines(output: CliOutput, lines: readonly string[]): void {
  if (lines.length === 0) return;
  output.writeStdout(`${lines.join('\n')}\n`);
}

export function writeCliSummary(
  output: CliOutput,
  lines: readonly CliSummaryLine[],
  styles?: CliStyles,
  options?: CliTableOptions,
): void {
  writeCliLines(output, renderCliSummary(lines, styles, options));
}

/** lifecycle tables default to padded rows and retain their workspace footer. */
export function renderCliLifecycleTable(
  lines: readonly CliLifecycleLine[],
  workspaceDir: string,
  styles: CliStyles = defaultCliStyles,
  terminalColumns = 80,
  options: Pick<CliTableOptions, 'rowPadding'> = {},
): string[] {
  const rows = renderCliTable(
    lines.map(({ attention, component, label, quiet, style, value }) => ({
      cells: [
        { value: component, ...(attention ? { style: 'bold' as const } : {}) },
        {
          value: label,
          style:
            style === 'action' || style === 'error' || style === 'status' || style === 'warning'
              ? style
              : 'field',
        },
      ],
      quiet,
      value,
    })),
    styles,
    { rowPadding: 1, ...options, terminalColumns },
  );
  return ['', ...rows, ...(rows.length ? [''] : []), `workspace  ${styles.bold(workspaceDir)}`, ''];
}

export function writeCliLifecycleTable(
  output: CliOutput,
  lines: readonly CliLifecycleLine[],
  workspaceDir: string,
  styles?: CliStyles,
  terminalColumns?: number,
  options?: Pick<CliTableOptions, 'rowPadding'>,
): void {
  writeCliLines(
    output,
    renderCliLifecycleTable(lines, workspaceDir, styles, terminalColumns, options),
  );
}

export interface CliNotice {
  message: string;
  severity: 'notice' | 'warning' | 'error';
}

/** render shared diagnostic blocks without dimming recovery guidance. */
export function renderCliNotices(
  notices: readonly CliNotice[],
  styles: CliStyles = defaultCliStyles,
  terminalColumns = 80,
): string[] {
  if (notices.length === 0) return [];
  const columns =
    Number.isFinite(terminalColumns) && terminalColumns >= 1 ? Math.floor(terminalColumns) : 80;
  const indent = ' '.repeat(Math.min(2, columns - 1));
  const messageWidth = Math.max(1, columns - indent.length);
  const priority = { error: 0, warning: 1, notice: 2 };
  const ordered = [...notices].sort(
    (left, right) => priority[left.severity] - priority[right.severity],
  );
  const blocks = ordered.flatMap(({ message, severity }, index) => {
    const label = { notice: 'ℹ info', warning: '⚠ warning', error: '✖ error' }[severity];
    const styledLabel = styles[severity](label);
    return [
      ...(index ? [''] : []),
      ...wrapAnsi(styledLabel, columns, { hard: true }).split('\n'),
      ...wrapAnsi(message, messageWidth, { hard: true })
        .split('\n')
        .map((line) => `${indent}${line}`),
    ];
  });
  return [
    '',
    ...wrapAnsi(styles.bold('messages'), columns, { hard: true }).split('\n'),
    '',
    ...blocks,
  ];
}

export interface CliDiagnosticOptions {
  output: CliOutput;
  json?: boolean;
  styles?: CliStyles;
  terminalColumns?: number;
}

/** preserve machine diagnostics while presenting human diagnostics on stderr. */
export function writeCliDiagnosticNotices(
  options: CliDiagnosticOptions,
  notices: readonly CliNotice[],
): void {
  if (options.output.collectNotices) {
    options.output.collectNotices(notices);
    return;
  }
  writeCliDiagnostics(
    options.output,
    options.json
      ? notices.map(({ message }) => message)
      : renderCliNotices(
          notices,
          options.styles,
          options.terminalColumns ?? process.stderr.columns,
        ),
  );
}

export function writeCliJson(output: CliOutput, value: unknown): void {
  output.writeStdout(`${JSON.stringify(value, undefined, 2)}\n`);
}

export function writeCliDiagnostics(output: CliOutput, messages: readonly string[]): void {
  if (messages.length === 0) return;
  if (output.collectNotices) {
    output.collectNotices(messages.map((message) => ({ severity: 'notice', message })));
    return;
  }
  output.writeStderr(`${messages.join('\n')}\n`);
}

export function writeCliError(
  output: CliOutput,
  message: string,
  options: Omit<CliDiagnosticOptions, 'output'> = {},
): void {
  writeCliDiagnosticNotices({ ...options, output }, [{ severity: 'error', message }]);
}

export const defaultCliOutput: CliOutput = {
  writeStderr: (value) => process.stderr.write(value),
  writeStdout: (value) => defaultRuntime.writeStdout(value),
};
