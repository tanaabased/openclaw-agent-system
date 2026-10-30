import { stripVTControlCharacters } from 'node:util';

import redactFeedback from './feedback-redaction.ts';
import type { SetupCommandResult } from './setup-runner.ts';

// bound chat excerpts to 16 kib per stream; full capture stays in native history.
const excerptBytes = 16 * 1024;

function excerpt(text: string, omitted = 0) {
  const clean = redactFeedback(
    stripVTControlCharacters(text)
      // eslint-disable-next-line no-control-regex -- remove terminal control bytes from chat excerpts
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '')
      .replace(/\b(?:gh[pousr]_|github_pat_|ops_|opsa_)[A-Za-z0-9_]+/gu, '[redacted]'),
  );
  const bytes = Buffer.from(clean);
  const prefix = bytes.subarray(0, excerptBytes);
  // streaming decode omits an incomplete final code point.
  const body = new TextDecoder().decode(prefix, { stream: bytes.length > excerptBytes });
  const lost = omitted + Math.max(0, bytes.length - Buffer.byteLength(body));
  return { body, note: lost ? `[${lost} bytes omitted; see native automation run history.]` : '' };
}

export interface AutomationReportInput {
  id: string;
  executionId: string;
  startedAt: string;
  result: SetupCommandResult;
  cancelled: boolean;
}

export function automationExecutionSucceeded(
  input: Pick<AutomationReportInput, 'result' | 'cancelled'>,
) {
  return (
    input.result.exitCode === 0 &&
    !input.result.timedOut &&
    !input.cancelled &&
    !input.result.signal &&
    (!input.result.termination || input.result.termination === 'exit')
  );
}

export default function automationReport(input: AutomationReportInput): string {
  const { result } = input;
  const success = automationExecutionSucceeded(input);
  const unknown =
    result.exitCode === null &&
    !result.timedOut &&
    !input.cancelled &&
    !result.signal &&
    (!result.termination || result.termination === 'exit');
  const reason =
    result.timedOut || result.termination === 'no-output-timeout'
      ? 'timed out'
      : input.cancelled
        ? 'cancelled'
        : result.signal || result.termination === 'signal'
          ? 'stopped by signal'
          : result.exitCode === null
            ? 'execution result unavailable'
            : `exit code ${result.exitCode}`;
  const stdout = excerpt(result.output?.stdout ?? '', result.output?.stdoutTruncatedBytes);
  const stderr = excerpt(result.output?.stderr ?? '', result.output?.stderrTruncatedBytes);
  // a longer fence prevents diagnostic text from closing its code block.
  const fence = '`'.repeat(
    Math.max(3, ...Array.from(stderr.body.matchAll(/`+/gu), ([run]) => run.length + 1)),
  );
  return [
    `## ${success ? 'Succeeded' : unknown ? 'Unknown' : 'Failed'}: ${input.id}`,
    `${input.startedAt} · Execution \`${input.executionId}\` · ${reason}`,
    '### Output',
    stdout.body ||
      (unknown
        ? 'No stdout was captured.'
        : success
          ? 'Command completed without stdout.'
          : 'Command failed without stdout.'),
    stdout.note,
    ...(stderr.body || stderr.note
      ? ['### Diagnostics', `${fence}text\n${stderr.body}\n${fence}`, stderr.note]
      : []),
  ]
    .filter(Boolean)
    .join('\n\n');
}
