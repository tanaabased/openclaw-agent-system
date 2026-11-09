import assert from 'node:assert/strict';

import automationReport, {
  automationReportCardValid,
  automationReportInstructionsFor,
  prepareAutomationReport,
  type AutomationReportInput,
} from '../agent/automation-report.ts';
import classifyAutomationReport from '../agent/automation-report-schema.ts';
import { renderStructuredReport } from '../agent/automation-report-presentation.ts';

const input: AutomationReportInput = {
  id: 'backup',
  executionId: 'execution-1',
  startedAt: '2026-11-03T00:00:00Z',
  cancelled: false,
  result: { exitCode: 0, timedOut: false, truncated: false, output: { stdout: '', stderr: '' } },
};
const structured = {
  id: 'a',
  format: 'structured',
  title: 'Source A',
  status: 'warning',
  summary: 'Activation unverified.',
};
const markdown =
  '## Source B\n\n| item | status |\n| --- | --- |\n| b | saved |\n\n```sh\necho done\n```\n';
const envelope = (cards: unknown[] = [structured]) => ({
  schema: 'agent-system.report',
  version: 1,
  cards,
});
function prepare(document: unknown, overrides: Partial<AutomationReportInput['result']> = {}) {
  return prepareAutomationReport({
    ...input,
    result: {
      ...input.result,
      ...overrides,
      output: { stdout: JSON.stringify(document), stderr: '', ...overrides.output },
    },
  });
}
function expected(report: ReturnType<typeof prepareAutomationReport>) {
  assert.ok(report.presentation && report.presentation.kind !== 'fallback');
  return report.presentation.body;
}

describe('agent/automation-report-document', () => {
  it('should supply four separate cards once as literal copy-ready text', () => {
    const cards = ['canon', 'emori', 'smutlord', 'openclaw-agent-system'].map((id) => ({
      ...structured,
      id,
      title: id,
      summary: 'Saved [source] at C:\\archive.',
    }));
    const report = prepare(envelope(cards));
    const body = expected(report);
    const prompt = automationReport(report);
    const marker = '\n<response_body>\n';
    const [metadata, section] = prompt.split(marker);
    const literal = section!.slice(0, section!.indexOf('\n</response_body>'));
    assert.equal(literal, body);
    assert.ok(!metadata!.includes(JSON.stringify(body)));
    assert.ok(!metadata!.includes('> ## ⚠️ canon'));
    assert.equal(body.split('\n\n> ##').length, 4);
    assert.ok(body.includes('\n\n**Runner result:**'));
    assert.equal(automationReportCardValid(body, report), true);
    for (const changed of [
      body.replaceAll('\n\n> ##', '\n>\n> ##'),
      body + '\n\n' + body,
      body + '\n\n' + JSON.stringify(body),
      `<response_body>\n${body}\n</response_body>`,
      body + '\n\nPrivate context: git protocol ssh',
      body +
        '\n\n' +
        renderStructuredReport({
          ...cards[0]!,
          format: 'structured',
          status: 'warning',
          summary: body,
        }),
    ])
      assert.equal(automationReportCardValid(changed, report), false);
  });
  it('should prepare mixed cards in order without interpreting or wrapping authored markdown', () => {
    const report = prepare(envelope([structured, { id: 'b', format: 'markdown', body: markdown }]));
    assert.equal(report.presentation?.kind, 'preferred');
    const body = expected(report);
    assert.ok(body.startsWith('> ## ⚠️ Source A\n>\n> Activation unverified.\n\n' + markdown));
    assert.equal(body.split('**Runner result:**').length, 2);
    assert.ok(body.includes('**Runner result:** ✅ backup'));
    assert.ok(!body.includes('> ## Source B'));
    assert.ok(automationReportCardValid(body, report));
    assert.ok(automationReportInstructionsFor(report).includes('Copy presentation.body exactly'));
    for (const altered of [
      'Summary\n' + body,
      body.replace(markdown, '> ' + markdown),
      body.replace('unverified', 'verified'),
      body + '\n',
      body.replace(markdown, ''),
    ])
      assert.equal(automationReportCardValid(altered, report), false);
    const single = prepare(envelope([{ id: 'b', format: 'markdown', body: markdown }]));
    assert.ok(expected(single).startsWith(markdown + '\n\n**Runner result:**'));
  });

  it('should escape structured fields and omit absent or empty optional sections', () => {
    const body = renderStructuredReport({
      id: 'a',
      format: 'structured',
      title: '[link](bad) <html>',
      status: 'success',
      summary: 'Line\n# heading',
      facts: [{ label: '*source*', value: '[value]' }],
      findings: [],
      actions: ['Read result'],
    });
    assert.ok(body.includes('\\[link\\]\\(bad\\) &lt;html&gt;'));
    assert.ok(body.includes('> \\# heading'));
    assert.ok(body.includes('**Facts**'));
    assert.ok(body.includes('**Suggested next actions**'));
    assert.ok(!body.includes('**Findings**'));
  });

  it('should keep application outcomes separate from runner failure and capture notices', () => {
    for (const override of [
      { exitCode: 17 },
      { timedOut: true },
      { signal: 'SIGTERM' },
      { termination: 'no-output-timeout' as const },
      { exitCode: null },
    ]) {
      const report = prepare(envelope([{ ...structured, status: 'success' }]), override);
      assert.ok(expected(report).startsWith('> ## ✅ Source A'));
      assert.ok(
        expected(report).includes(
          `**Runner result:** ${report.outcome === 'unknown' ? '⚠️' : '❌'}`,
        ),
      );
      assert.equal(automationReportCardValid(expected(report), report), true);
    }
    const cancelled = prepareAutomationReport({
      ...input,
      cancelled: true,
      result: { ...input.result, output: { stdout: JSON.stringify(envelope()), stderr: '' } },
    });
    assert.ok(expected(cancelled).includes('Cancelled'));
    const stderr = prepare(envelope(), {
      truncated: true,
      output: { stdout: JSON.stringify(envelope()), stderr: 'progress', stderrTruncatedBytes: 9 },
    });
    assert.equal(stderr.presentation?.kind, 'preferred');
    assert.ok(expected(stderr).includes('stderr omitted 9 bytes'));
    assert.ok(expected(stderr).includes('Runner stderr (diagnostic data)'));
    assert.ok(expected(stderr).startsWith('> ## ⚠️'));
  });

  it('should fit arbitrary output into the same standard presentation without guessing cards', () => {
    for (const stdout of [
      '{}',
      '[]',
      'null',
      '42',
      'true',
      '"text"',
      '# Raw Markdown',
      'progress\n{"ok":true}',
      '',
      '{broken',
    ]) {
      const report = prepareAutomationReport({
        ...input,
        result: { ...input.result, output: { stdout, stderr: '' } },
      });
      assert.equal(report.presentation?.kind, 'fallback');
      if (report.presentation?.kind !== 'fallback') throw Error('unexpected preferred output');
      const card = renderStructuredReport({
        id: 'fallback',
        format: 'structured',
        title: 'Backup',
        status: 'success',
        summary: 'Reported completion.',
        facts: [{ label: 'Source', value: 'Reported' }],
      });
      const body = card + '\n\n' + report.presentation.footer;
      assert.equal(automationReportCardValid(body, report), true);
      assert.equal(automationReportCardValid(body.replace('Exit 0', 'Exit 9'), report), false);
      assert.equal(automationReportCardValid(card + '\n\n' + body, report), false);
      assert.ok(automationReportInstructionsFor(report).includes('**Facts**'));
    }
  });

  it('should diagnose claimed schema defects without leaking raw output or falling back', () => {
    const invalid: Array<[unknown, string]> = [
      [{ ...envelope(), version: 9 }, 'report-version-unsupported'],
      [envelope([]), 'report-schema-invalid'],
      [envelope([{ ...structured, id: '' }]), 'report-schema-invalid'],
      [envelope([structured, structured]), 'report-card-id-duplicate'],
      [envelope([{ ...structured, format: 'text' }]), 'report-schema-invalid'],
      [envelope([{ ...structured, body: 'contradiction' }]), 'report-schema-invalid'],
      [
        envelope([{ id: 'b', format: 'markdown', body: markdown, status: 'success' }]),
        'report-schema-invalid',
      ],
      [{ ...envelope(), extra: 'ghp_secretvalue' }, 'report-schema-invalid'],
      [envelope([{ ...structured, title: 'two\nlines' }]), 'report-schema-invalid'],
    ];
    for (const [value, code] of invalid) {
      const report = prepare(value);
      assert.equal(report.presentation?.kind, 'diagnostic');
      assert.ok(expected(report).includes(code));
      assert.ok(!automationReport(report).includes('secretvalue'));
      assert.equal(automationReportCardValid(expected(report), report), true);
    }
  });

  it('should recognize only top-level claims in malformed or incomplete documents', () => {
    for (const source of [
      '{"schema":"agent-system.report",',
      '{"ignored":{"a":[1,"quoted,]value"]},"schema":"agent-system.report",',
    ])
      assert.equal(classifyAutomationReport(source, false, 16384).kind, 'diagnostic');
    for (const source of [
      'log: "schema":"agent-system.report"',
      '{"log":"schema: agent-system.report"',
      '{"nested":{"schema":"agent-system.report"}}',
      '{"broken":nope,"schema":"agent-system.report"}',
    ])
      assert.equal(classifyAutomationReport(source, false, 16384).kind, 'fallback');
    const source = JSON.stringify(envelope());
    assert.deepEqual(classifyAutomationReport(source, true, 16384), {
      kind: 'diagnostic',
      code: 'report-incomplete',
    });
    assert.deepEqual(classifyAutomationReport(source, false, Buffer.byteLength(source) - 1), {
      kind: 'diagnostic',
      code: 'report-too-large',
    });
    assert.equal(
      classifyAutomationReport(source, false, Buffer.byteLength(source)).kind,
      'preferred',
    );
    const chunks = [source.slice(0, 11), source.slice(11, 29), source.slice(29)];
    assert.equal(classifyAutomationReport(chunks.join(''), false, 16384).kind, 'preferred');
  });

  it('should keep worst escaped source and stderr expansion within retained storage without dropping cards', () => {
    const doc = envelope([{ ...structured, summary: '&'.repeat(15000) }]);
    const report = prepare(doc, {
      output: { stdout: JSON.stringify(doc), stderr: '`'.repeat(16384) },
    });
    assert.equal(report.presentation?.kind, 'preferred');
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 256 * 1024);
    assert.ok(expected(report).includes('&amp;'.repeat(15000)));
    assert.ok(automationReportCardValid(expected(report), report));
  });

  it('should sanitize decoded values before model input and reject empty sanitized cards', () => {
    const report = prepare(
      envelope([
        {
          id: 'b',
          format: 'markdown',
          body: '\u001b[31m## Red\u001b[0m\n\nghp_privatevalue\nAuthorization: Bearer another-secret',
        },
      ]),
    );
    assert.equal(report.presentation?.kind, 'preferred');
    const prompt = automationReport(report);
    for (const value of ['privatevalue', 'another-secret', '\u001b'])
      assert.ok(!prompt.includes(value));
    assert.ok(expected(report).includes('[private content withheld]'));
    assert.ok(
      expected(
        prepare(envelope([{ id: 'b', format: 'markdown', body: 'ghp_privatevalue' }])),
      ).includes('[redacted]'),
    );
    assert.equal(
      prepare(envelope([{ id: 'b', format: 'markdown', body: '\u0000' }])).presentation?.kind,
      'diagnostic',
    );
    const oversized = prepare(envelope([{ id: 'b', format: 'markdown', body: '€'.repeat(6000) }]));
    assert.ok(expected(oversized).includes('report-too-large'));
    assert.ok(!expected(oversized).includes('€'));
  });
});
