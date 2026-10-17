import { type CliDiagnosticOptions, type CliNotice, writeCliDiagnosticNotices } from './output.ts';

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
      writeCliDiagnosticNotices(options, notices);
    }
  };
}
