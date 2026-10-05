import assert from 'node:assert/strict';

import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import {
  createCliStyles,
  renderCliNotices,
  renderCliSummary,
  writeCliDiagnostics,
  writeCliJson,
  writeCliSummary,
} from '../cli/output.ts';

const plainStyles = createCliStyles({ NO_COLOR: '1' });

describe('cli/output', () => {
  it('should align each summary to its own longest label without color', () => {
    assert.deepEqual(
      renderCliSummary(
        [
          { label: 'valid', style: 'status', value: 'op credential for data' },
          { label: 'source', style: 'target', value: 'store:file' },
          { label: 'environments', style: 'field', value: '1' },
        ],
        plainStyles,
      ),
      ['valid         op credential for data', 'source        store:file', 'environments  1'],
    );
  });

  it('should apply semantic and brand styling only when color is enabled', () => {
    const lines = renderCliSummary(
      [
        { label: 'stored', style: 'action', value: 'op credential for data' },
        { label: 'store', style: 'target', value: 'file' },
      ],
      createCliStyles({ FORCE_COLOR: '1' }),
    );

    assert.equal(
      lines.every((line) => line.includes('\u001B[')),
      true,
    );
    assert.deepEqual(
      lines.map((line) => ansis.strip(line)),
      ['stored  op credential for data', 'store   file'],
    );
  });

  it('should render error and warning summaries with semantic styles', () => {
    const markerStyles = {
      accent: (value: string) => `<accent>${value}</accent>`,
      action: (value: string) => `<action>${value}</action>`,
      bold: (value: string) => `<bold>${value}</bold>`,
      error: (value: string) => `<error>${value}</error>`,
      field: (value: string) => `<field>${value}</field>`,
      notice: (value: string) => `<notice>${value}</notice>`,
      status: (value: string) => `<status>${value}</status>`,
      target: (value: string) => `<target>${value}</target>`,
      warning: (value: string) => `<warning>${value}</warning>`,
    };

    assert.deepEqual(
      renderCliSummary(
        [
          { label: 'blocked', style: 'error', value: 'inspection failed' },
          { label: 'drift', style: 'warning', value: 'configuration differs' },
        ],
        markerStyles,
      ),
      [
        '<error>blocked  </error>inspection failed',
        '<warning>drift    </warning>configuration differs',
      ],
    );
  });

  it('should align optional lifecycle components as a third summary column', () => {
    assert.deepEqual(
      renderCliSummary(
        [
          { component: 'manifest', label: 'valid', style: 'status', value: 'Agent manifest' },
          { component: 'github', label: 'valid', style: 'status', value: 'Tool configuration' },
          { label: 'manifest', style: 'target', value: '/workspace/agent.yaml' },
        ],
        plainStyles,
      ),
      [
        'valid     manifest  Agent manifest',
        'valid     github    Tool configuration',
        'manifest            /workspace/agent.yaml',
      ],
    );
  });

  it('should write one trailing newline for human summaries', () => {
    const written: string[] = [];

    writeCliSummary(
      { writeStderr() {}, writeStdout: (value) => written.push(value) },
      [{ label: 'valid', style: 'status', value: 'Agent System manifest for data' }],
      plainStyles,
    );

    assert.deepEqual(written, ['valid  Agent System manifest for data\n']);
  });

  it('should keep json output undecorated', () => {
    const written: string[] = [];

    writeCliJson(
      { writeStderr() {}, writeStdout: (value) => written.push(value) },
      { agentId: 'data' },
    );

    assert.deepEqual(written, ['{\n  "agentId": "data"\n}\n']);
  });

  it('should write diagnostics only to stderr', () => {
    const stderr: string[] = [];
    const stdout: string[] = [];

    writeCliDiagnostics(
      {
        writeStderr: (value) => stderr.push(value),
        writeStdout: (value) => stdout.push(value),
      },
      ['first diagnostic', 'second diagnostic'],
    );

    assert.deepEqual(stderr, ['first diagnostic\nsecond diagnostic\n']);
    assert.deepEqual(stdout, []);
  });

  it('should render labelled notices with hanging indentation and neutral content', () => {
    const lines = renderCliNotices(
      [
        {
          severity: 'notice',
          message: 'Channel-wide operator recognition remains subject to tool policy.',
        },
        { severity: 'warning', message: 'Reload the Gateway, then verify a fresh assignment.' },
      ],
      plainStyles,
      32,
    );

    assert.deepEqual(lines, [
      '',
      'Notices',
      '',
      'ℹ Notice',
      '  Channel-wide operator',
      '  recognition remains subject to',
      '  tool policy.',
      '⚠ Warning',
      '  Reload the Gateway, then',
      '  verify a fresh assignment.',
    ]);
  });

  it('should style only notice labels when color is enabled', () => {
    const lines = renderCliNotices(
      [{ severity: 'notice', message: 'Information remains readable.' }],
      createCliStyles({ FORCE_COLOR: '1' }),
    );

    assert.equal(ansis.strip(lines[3] ?? ''), 'ℹ Notice');
    assert.equal(lines[4], '  Information remains readable.');
    assert.notEqual(lines[3], ansis.strip(lines[3] ?? ''));
  });
  it('should render red errors with neutral guidance at narrow widths and honor no-color', () => {
    const notices = [
      { severity: 'warning' as const, message: 'Keep accumulated warning.' },
      {
        severity: 'error' as const,
        message: 'collaboration: Cannot reconcile. code=collaboration-failed',
      },
      {
        severity: 'notice' as const,
        message: 'Unattempted work: models. Fix configuration then rerun install.',
      },
    ];
    for (const columns of [1, 12, 32, 80]) {
      const colored = renderCliNotices(notices, createCliStyles({ FORCE_COLOR: '3' }), columns);
      const plain = renderCliNotices(
        notices,
        createCliStyles({ NO_COLOR: '', FORCE_COLOR: '3' }),
        columns,
      );
      assert.deepEqual(
        colored.map((line) => ansis.strip(line)),
        plain,
      );
      assert.ok(plain.every((line) => stringWidth(line) <= columns && !line.includes('\u001b')));
      assert.match(plain.join('').replace(/\s+/gu, ''), /Cannotreconcile/u);
    }
    const colored = renderCliNotices(notices, createCliStyles({ FORCE_COLOR: '1' }), 120);
    assert.ok(colored.some((line) => line.includes('✖ Error') && line.includes('\u001b[31m')));
    assert.ok(
      colored.some((line) => line.includes('Cannot reconcile') && line.includes('\u001b[31m')),
    );
    assert.ok(
      colored.includes('  Unattempted work: models. Fix configuration then rerun install.'),
    );
  });
});
