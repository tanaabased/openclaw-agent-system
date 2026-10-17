import assert from 'node:assert/strict';

import { createCliStyles, writeCliDiagnosticNotices, writeCliJson } from '../cli/output.ts';
import presentCliCommand from '../cli/presentation.ts';

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
});
