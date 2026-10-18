import assert from 'node:assert/strict';

import {
  type CliNotice,
  createCliStyles,
  writeCliDiagnosticNotices,
  writeCliJson,
} from '../cli/output.ts';
import presentCliCommand, { coalesceCliNotices } from '../cli/presentation.ts';

describe('cli/presentation', () => {
  it('should collect nested diagnostics once after primary output and preserve machine streams', async () => {
    for (const json of [false, true]) {
      const events: Array<{ stream: string; text: string }> = [];
      const nested = presentCliCommand(async (options) => {
        writeCliDiagnosticNotices(options, [
          { severity: 'warning', message: 'Operation warning.' },
        ]);
        writeCliJson(options.output, { status: 'ready' });
      });
      const command = presentCliCommand(async (options) => {
        writeCliDiagnosticNotices(options, [{ severity: 'notice', message: 'Manifest notice.' }]);
        await nested(options);
      });
      await command({
        json,
        output: {
          writeStdout: (text) => events.push({ stream: 'stdout', text }),
          writeStderr: (text) => events.push({ stream: 'stderr', text }),
        },
        styles: createCliStyles({ FORCE_COLOR: '3' }),
      });
      assert.deepEqual(
        events.map(({ stream }) => stream),
        ['stdout', 'stderr'],
      );
      assert.deepEqual(JSON.parse(events[0]!.text), { status: 'ready' });
      if (json) assert.equal(events[1]!.text, 'Manifest notice.\nOperation warning.\n');
      else {
        assert.equal(events[1]!.text.match(/messages/gu)?.length, 1);
        assert.match(
          events[1]!.text,
          /warning[\s\S]*Operation warning[\s\S]*info[\s\S]*Manifest notice/u,
        );
      }
    }
  });

  it('should leave consent output immediate but defer diagnostics through early returns and failures', async () => {
    for (const fails of [false, true]) {
      const events: string[] = [];
      const command = presentCliCommand(async (options) => {
        writeCliDiagnosticNotices(options, [{ severity: 'warning', message: 'Retained warning.' }]);
        options.output.writeStderr('Consent preview.\n');
        assert.deepEqual(events, ['Consent preview.\n']);
        writeCliDiagnosticNotices(options, [
          { severity: 'error', message: 'Stopped before mutation.' },
        ]);
        if (fails) throw new Error('operation failed');
        return 'declined';
      });
      const result = command({
        output: { writeStdout() {}, writeStderr: (text) => events.push(text) },
        styles: createCliStyles({ NO_COLOR: '1' }),
      });
      if (fails) await assert.rejects(result, /operation failed/u);
      else assert.equal(await result, 'declined');
      assert.equal(events.length, 2);
      assert.match(events[1]!, /messages[\s\S]*Stopped before mutation[\s\S]*Retained warning/u);
    }
  });
  it('should merge proven conditions without mutating inputs or losing complementary evidence', () => {
    const condition = {
      key: 'missing-capability',
      component: 'github-intake',
      fieldPath: '/review',
    };
    const notices: readonly CliNotice[] = Object.freeze([
      Object.freeze({
        severity: 'warning',
        message: 'Unavailable.',
        condition,
        code: 'unsupported',
        details: Object.freeze(['safe evidence']),
      }),
      Object.freeze({
        severity: 'error',
        message: 'Execution is blocked.',
        condition,
        code: 'unsupported',
        remediation: Object.freeze(['choose supported mode']),
      }),
      Object.freeze({
        severity: 'notice',
        message: 'Unavailable.',
        condition,
        code: 'unsupported',
        details: Object.freeze(['safe evidence', 'additional evidence']),
      }),
    ]);
    const before = JSON.stringify(notices);
    const merged = coalesceCliNotices(notices);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.severity, 'error');
    assert.equal(merged[0]!.message, 'Unavailable.\nExecution is blocked.');
    assert.deepEqual(merged[0]!.details, ['safe evidence', 'additional evidence']);
    assert.deepEqual(merged[0]!.remediation, ['choose supported mode']);
    assert.equal(JSON.stringify(notices), before);
  });

  it('should enrich missing diagnostic attributes but preserve conflicting codes', () => {
    const condition = { key: 'configuration', component: 'setup' };
    const first: CliNotice = {
      condition,
      message: 'Configuration unavailable.',
      severity: 'warning',
    };
    const second: CliNotice = { ...first, code: 'configuration-invalid', details: ['safe detail'] };
    const merged = coalesceCliNotices([first, second]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.code, second.code);
    assert.equal(coalesceCliNotices([second, { ...second, code: 'different-cause' }]).length, 2);
  });
  it('should preserve distinct scopes, causes, occurrences and uncorrelated observations', () => {
    const base: CliNotice = {
      severity: 'warning',
      message: 'Same text.',
      code: 'shared-code',
      condition: { key: 'missing-capability', component: 'one' },
    };
    const variants = [
      { component: 'two' },
      { fieldPath: '/one' },
      { fieldPath: '/two' },
      { stepId: 'one' },
      { stepId: 'two' },
      { resource: 'one' },
      { resource: 'two' },
      { occurrence: 'attempt-one' },
      { occurrence: 'attempt-two' },
      { key: 'different-cause' },
    ];
    const notices: CliNotice[] = [
      base,
      ...variants.map((scope) => ({ ...base, condition: { ...base.condition!, ...scope } })),
      { severity: 'warning', message: 'Same text.' },
      { severity: 'warning', message: 'Same text.' },
    ];
    assert.equal(coalesceCliNotices(notices).length, notices.length);
  });

  it('should coalesce nested observations per invocation with mode-specific ordering', async () => {
    for (const json of [false, true]) {
      const events: Array<{ stream: string; text: string }> = [];
      const condition = { key: 'capability', component: 'notifications' };
      const nested = presentCliCommand(async (options) => {
        options.output.writeStdout('raw child stdout');
        options.output.writeStderr('raw child stderr');
        writeCliDiagnosticNotices(options, [
          {
            condition,
            severity: 'error',
            message: 'first condition',
            details: ['safe detail'],
            remediation: ['recover here'],
          },
        ]);
      });
      const command = presentCliCommand(async (options) => {
        writeCliDiagnosticNotices(options, [
          { severity: 'notice', message: 'earliest info' },
          { condition, severity: 'warning', message: 'first condition' },
          { severity: 'warning', message: 'distinct warning' },
        ]);
        await nested(options);
      });
      const options = {
        json,
        styles: createCliStyles({ NO_COLOR: '1' }),
        output: {
          writeStdout: (text: string) => events.push({ stream: 'stdout', text }),
          writeStderr: (text: string) => events.push({ stream: 'stderr', text }),
        },
      };
      for (let invocation = 0; invocation < 2; invocation++) {
        events.length = 0;
        await command(options);
        assert.deepEqual(events.slice(0, 2), [
          { stream: 'stdout', text: 'raw child stdout' },
          { stream: 'stderr', text: 'raw child stderr' },
        ]);
        assert.equal(events.length, 3);
        const diagnostic = events[2]!.text;
        assert.equal(diagnostic.match(/first condition/gu)?.length, 1);
        assert.match(diagnostic, /safe detail[\s\S]*recover here/u);
        if (json)
          assert.ok(diagnostic.indexOf('earliest info') < diagnostic.indexOf('first condition'));
        else
          assert.ok(
            diagnostic.indexOf('first condition') < diagnostic.indexOf('distinct warning') &&
              diagnostic.indexOf('distinct warning') < diagnostic.indexOf('earliest info'),
          );
      }
    }
  });
});
