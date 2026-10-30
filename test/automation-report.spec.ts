import assert from 'node:assert/strict';

import automationReport, { type AutomationReportInput } from '../agent/automation-report.ts';

const input: AutomationReportInput = {
  id: 'backup',
  executionId: 'execution-1',
  startedAt: '2026-10-30T00:00:00Z',
  cancelled: false,
  result: { exitCode: 0, timedOut: false, truncated: false, termination: 'exit' },
};
describe('agent/automation-report', () => {
  it('should preserve markdown output and distinguish fenced diagnostics', () => {
    const markdown =
      '# Backup\n\n- [archive](https://example.test/archive)\n\n| item | result |\n| --- | --- |\n| data | saved |\n\n```sh\necho done\n```';
    const report = automationReport({
      ...input,
      result: {
        ...input.result,
        output: { stdout: markdown, stderr: 'warning\n```\nnot a heading' },
      },
    });
    assert.ok(report.startsWith('## Succeeded: backup'));
    assert.ok(report.includes(markdown));
    assert.ok(report.includes('````text\nwarning\n```\nnot a heading\n````'));
    assert.ok(report.includes('execution-1'));
  });
  it('should derive failure from process facts even when stdout claims success', () => {
    for (const result of [
      { ...input.result, exitCode: 17 },
      { ...input.result, timedOut: true },
      { ...input.result, signal: 'SIGTERM' },
      { ...input.result, termination: 'no-output-timeout' as const },
    ])
      assert.match(
        automationReport({
          ...input,
          result: { ...result, output: { stdout: 'Everything succeeded!', stderr: '' } },
        }),
        /^## Failed:/u,
      );
    assert.match(automationReport({ ...input, cancelled: true }), /cancelled/u);
  });
  it('should report empty streams and unavailable completion without inventing output', () => {
    assert.match(automationReport(input), /Command completed without stdout/u);
    const unavailable = automationReport({ ...input, result: { ...input.result, exitCode: null } });
    assert.match(unavailable, /^## Unknown:/u);
    assert.match(unavailable, /execution result unavailable/u);
    assert.match(
      automationReport({ ...input, result: { ...input.result, timedOut: true } }),
      /timed out/u,
    );
  });
  it('should bound multibyte excerpts and redact credentials and terminal controls', () => {
    const report = automationReport({
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
    assert.ok(!report.includes('ghp_fixturetoken'));
    assert.ok(
      !['\u001b', '\u0000', '\u202e', '\ufffd'].some((character) => report.includes(character)),
    );
    assert.ok(report.includes('43627 bytes omitted'));
    assert.ok(Buffer.byteLength(report) < 34_000);
    assert.ok(
      !automationReport({
        ...input,
        result: {
          ...input.result,
          output: { stdout: '', stderr: 'Authorization: Bearer private-value' },
        },
      }).includes('private-value'),
    );
  });
});
