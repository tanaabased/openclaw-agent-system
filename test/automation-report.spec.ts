import assert from 'node:assert/strict';

import automationReport, {
  automationReportCardValid,
  prepareAutomationReport,
  type AutomationReportInput,
} from '../agent/automation-report.ts';

const input: AutomationReportInput = {
  id: 'backup',
  executionId: 'execution-1',
  startedAt: '2026-10-30T00:00:00Z',
  cancelled: false,
  result: {
    exitCode: 0,
    timedOut: false,
    truncated: false,
    termination: 'exit',
    output: { stdout: '', stderr: '' },
  },
};
describe('agent/automation-report', () => {
  it('should retain useful markdown and separately classify both streams without promoting stderr to failure', () => {
    const markdown =
      '# Backup\n\n- [archive](https://example.test/archive)\n\n| item | result |\n| --- | --- |\n| data | saved |\n\n```sh\necho done\n```';
    const report = prepareAutomationReport({
      ...input,
      result: { ...input.result, output: { stdout: markdown, stderr: '{"progress":100}' } },
    });
    assert.equal(report.stdout.body, markdown);
    assert.equal(report.stdout.format, 'text');
    assert.equal(report.stderr.format, 'json');
    assert.equal(report.outcome, 'success');
    assert.ok(automationReport(report).includes(JSON.stringify(report)));
  });
  it('should accept every complete json value and fall back on mixed or malformed text', () => {
    for (const stdout of ['{}', '[]', 'null', 'true', '42', '"hello"']) {
      const report = prepareAutomationReport({
        ...input,
        result: { ...input.result, output: { stdout, stderr: '' } },
      });
      assert.equal(report.stdout.format, 'json');
    }
    for (const stdout of ['{broken', '{"ok":true}\nprogress', '# Results']) {
      assert.equal(
        prepareAutomationReport({
          ...input,
          result: { ...input.result, output: { stdout, stderr: '' } },
        }).stdout.format,
        'text',
      );
    }
    assert.equal(prepareAutomationReport(input).stdout.format, 'empty');
  });
  it('should derive failure from process facts even when stdout claims success', () => {
    for (const result of [
      { ...input.result, exitCode: 17 },
      { ...input.result, timedOut: true },
      { ...input.result, signal: 'SIGTERM' },
      { ...input.result, termination: 'no-output-timeout' as const },
    ]) {
      const report = prepareAutomationReport({
        ...input,
        result: { ...result, output: { stdout: '{"success":true}', stderr: '' } },
      });
      assert.equal(report.outcome, 'error');
      assert.equal(
        automationReportCardValid(`> ## ✅ Backup completed\n>\n> ${report.runLine}`, report),
        false,
      );
      assert.equal(
        automationReportCardValid(`> ## ❌ Backup failed\n>\n> ${report.runLine}`, report),
        true,
      );
    }
    assert.equal(prepareAutomationReport({ ...input, cancelled: true }).outcome, 'error');
    assert.equal(
      prepareAutomationReport({ ...input, result: { ...input.result, exitCode: null } }).outcome,
      'unknown',
    );
  });
  it('should reject a missing or altered authoritative run line and unquoted card content', () => {
    const report = prepareAutomationReport(input);
    for (const body of [
      '> ## ✅ Done',
      `> ## ✅ Done\n> ${report.runLine.replace('Exit 0', 'Exit 9')}`,
      `> ## ✅ Done\n> ${report.runLine}\nunquoted`,
    ])
      assert.equal(automationReportCardValid(body, report), false);
    assert.equal(
      automationReportCardValid(
        `> ## ⚠️ Completed with warnings\n>\n> ${report.runLine}\n>\n> Skipped one archive.`,
        report,
      ),
      true,
    );
  });
  it('should bound multibyte excerpts, disclose truncation and redact credentials before model input', () => {
    const report = prepareAutomationReport({
      ...input,
      result: {
        ...input.result,
        output: {
          stdout: '\u001b[31mred\u001b[0m\u0000\u202e ghp_fixturetoken',
          stderr: '€'.repeat(20_000),
          stderrTruncatedBytes: 10,
        },
      },
    });
    const prompt = automationReport(report);
    assert.ok(!prompt.includes('ghp_fixturetoken'));
    assert.ok(
      !['\u001b', '\u0000', '\u202e', '\ufffd'].some((character) => prompt.includes(character)),
    );
    assert.equal(report.stderr.omittedBytes, 43627);
    assert.equal(report.captureIncomplete, true);
    assert.ok(Buffer.byteLength(prompt) < 34_000);
    const truncated = prepareAutomationReport({
      ...input,
      result: { ...input.result, output: { stdout: '{}', stderr: '', stdoutTruncatedBytes: 1 } },
    });
    assert.equal(truncated.stdout.format, 'text');
    assert.equal(
      automationReportCardValid(`> ## ✅ Done\n> ${truncated.runLine}`, truncated),
      false,
    );
    assert.ok(
      !automationReport(
        prepareAutomationReport({
          ...input,
          result: {
            ...input.result,
            output: { stdout: '', stderr: 'Authorization: Bearer private-value' },
          },
        }),
      ).includes('private-value'),
    );
  });
});
