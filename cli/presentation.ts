import { type CliDiagnosticOptions, type CliNotice, writeCliDiagnosticNotices } from './output.ts';

const priority = { error: 0, warning: 1, notice: 2 };

/** merge only explicitly correlated observations, without modifying service results. */
export function coalesceCliNotices(notices: readonly CliNotice[]): CliNotice[] {
  const result: CliNotice[] = [];
  const positions = new Map<string, number[]>();
  for (const notice of notices) {
    const scope = notice.condition;
    const identity = scope
      ? JSON.stringify([
          scope.key,
          scope.component,
          scope.fieldPath,
          scope.stepId,
          scope.resource,
          scope.occurrence,
        ])
      : undefined;
    const candidates = (identity === undefined ? [] : (positions.get(identity) ?? [])).filter(
      (index) => {
        const previous = result[index]!;
        for (const field of [
          'component',
          'fieldPath',
          'stepId',
          'resource',
          'occurrence',
        ] as const) {
          if (
            previous[field] !== undefined &&
            notice[field] !== undefined &&
            previous[field] !== notice[field]
          )
            return false;
        }
        // conflicting codes may describe distinct causes; an absent code adds no evidence.
        return !previous.code || !notice.code || previous.code === notice.code;
      },
    );
    const position = candidates.length === 1 ? candidates[0] : undefined;
    if (position === undefined) {
      if (identity !== undefined)
        positions.set(identity, [...(positions.get(identity) ?? []), result.length]);
      result.push({ ...notice });
      continue;
    }
    const previous = result[position]!;
    result[position] = {
      ...previous,
      code: previous.code ?? notice.code,
      component: previous.component ?? notice.component,
      fieldPath: previous.fieldPath ?? notice.fieldPath,
      stepId: previous.stepId ?? notice.stepId,
      resource: previous.resource ?? notice.resource,
      occurrence: previous.occurrence ?? notice.occurrence,
      severity:
        priority[notice.severity] < priority[previous.severity]
          ? notice.severity
          : previous.severity,
      message: [...new Set([...previous.message.split('\n'), ...notice.message.split('\n')])].join(
        '\n',
      ),
      details: [...new Set([...(previous.details ?? []), ...(notice.details ?? [])])],
      remediation: [...new Set([...(previous.remediation ?? []), ...(notice.remediation ?? [])])],
    };
  }
  return result;
}

/** collect command-owned diagnostics and render one section after primary output. */
export default function presentCliCommand<
  Options extends CliDiagnosticOptions,
  Args extends unknown[],
  Result,
>(operation: (options: Options, ...args: Args) => Promise<Result>) {
  return async (options: Options, ...args: Args): Promise<Result> => {
    // nested command helpers participate in the existing presentation boundary.
    if (options.output.collectNotices) return operation(options, ...args);
    const notices: CliNotice[] = [];
    const output = {
      writeStdout: (value: string) => options.output.writeStdout(value),
      // consent previews and child-process streams are not command diagnostics.
      writeStderr: (value: string) => options.output.writeStderr(value),
      collectNotices: (values: readonly CliNotice[]) => notices.push(...values),
    };
    try {
      return await operation({ ...options, output }, ...args);
    } finally {
      writeCliDiagnosticNotices(options, coalesceCliNotices(notices));
    }
  };
}
