import type createCollaborationLifecycleContribution from '../agent/collaboration-lifecycle.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import { formatErrorDiagnostic } from '../core/logger.ts';
import { type CliOutput, writeCliError, writeCliJson } from './output.ts';

export type CollaborationLifecycle = Pick<
  ReturnType<typeof createCollaborationLifecycleContribution>,
  'inspectHost' | 'reconcileHost'
>;

/** expose host-only inspection and reconciliation even after the final workspace is removed. */
export default async function collaborationCommand(options: {
  operation: 'inspect' | 'install';
  lifecycle: CollaborationLifecycle;
  json: boolean;
  output: CliOutput;
  setExitCode(code: number): void;
}): Promise<void> {
  try {
    if (options.operation === 'inspect') {
      const findings = await options.lifecycle.inspectHost();
      if (options.json) writeCliJson(options.output, { findings });
      else
        for (const finding of findings)
          options.output.writeStdout(`${finding.status}: ${finding.message}\n`);
      if (findings.some(({ status }) => status !== 'healthy')) options.setExitCode(1);
    } else {
      const result = await options.lifecycle.reconcileHost();
      if (options.json) writeCliJson(options.output, result);
      else {
        for (const outcome of result.outcomes)
          options.output.writeStdout(`${outcome.status}: ${outcome.message}\n`);
        for (const warning of result.warnings) options.output.writeStderr(`${warning.message}\n`);
      }
    }
  } catch (error) {
    const code = error instanceof AgentSystemLifecycleError ? error.code : 'collaboration-failed';
    const message = formatErrorDiagnostic('collaboration', error, code);
    if (options.json) writeCliJson(options.output, { status: 'failed', code, message });
    writeCliError(options.output, message);
    options.setExitCode(1);
  }
}
