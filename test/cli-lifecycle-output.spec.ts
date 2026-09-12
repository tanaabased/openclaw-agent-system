import assert from 'node:assert/strict';

import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import { createCliStyles, type CliStyles, renderCliLifecycleTable } from '../cli/output.ts';
import { lifecycleTableLines } from '../core/lifecycle-presentation.ts';
import { doctorFindings, installOutcomes } from './lifecycle-presentation-fixtures.ts';

const plainStyles = createCliStyles({ NO_COLOR: '1' });
const markerStyles: CliStyles = {
  action: (value) => `<action>${value}</action>`,
  bold: (value) => `<bold>${value}</bold>`,
  error: (value) => `<error>${value}</error>`,
  field: (value) => `<dim>${value}</dim>`,
  status: (value) => `<status>${value}</status>`,
  target: (value) => `<target>${value}</target>`,
  warning: (value) => `<warning>${value}</warning>`,
};

describe('cli/lifecycle-output', () => {
  it('should style individual cells and keep workspace metadata neutral', () => {
    const rows = renderCliLifecycleTable(
      lifecycleTableLines([...doctorFindings, ...installOutcomes]),
      '/workspace',
      markerStyles,
      240,
    );
    for (const row of rows) {
      assert.equal(row.includes('<target>'), false);
    }
    assert.match(rows[0]!, /^agent +<status>healthy<\/status> +<dim>/);
    assert.match(rows[1]!, /^<bold>security<\/bold> +<warning>warning<\/warning> +This/);
    assert.match(rows[2]!, /^<bold>git<\/bold> +<error>blocked<\/error> +Git/);
    assert.match(rows[3]!, /^<bold>github-notifications<\/bold> +<bold>manual<\/bold> +Manual/);
    assert.match(rows[4]!, /^<bold>path<\/bold> +<warning>drift<\/warning> +Executable/);
    assert.match(rows[7]!, /^agent +<status>unchanged<\/status> +<dim>/);
    for (const row of rows.slice(8, 11)) {
      assert.match(row, /<action>(updated|created|removed)<\/action> +[^<]/);
      assert.equal(row.includes('<dim>') || row.includes('<bold>'), false);
    }
    assert.deepEqual(rows.slice(-2), ['', 'workspace  <bold>/workspace</bold>']);
  });

  it('should keep colored and no-color layouts identical, with no-color taking precedence', () => {
    const lines = lifecycleTableLines([...doctorFindings, ...installOutcomes]);
    const colored = renderCliLifecycleTable(
      lines,
      '/workspace',
      createCliStyles({ FORCE_COLOR: '3' }),
      80,
    );
    const plain = renderCliLifecycleTable(
      lines,
      '/workspace',
      createCliStyles({ NO_COLOR: '', FORCE_COLOR: '3' }),
      80,
    );
    assert.ok(colored.some((line) => line.includes('\u001b[')));
    assert.ok(plain.every((line) => !line.includes('\u001b')));
    assert.deepEqual(
      colored.map((line) => ansis.strip(line)),
      plain,
    );
    assert.equal(colored.at(-1), 'workspace  \u001b[1m/workspace\u001b[22m');
    for (const row of colored.filter((line) => line && !line.startsWith('workspace'))) {
      if (row.startsWith(' ')) {
        // eslint-disable-next-line no-control-regex -- Explanations must not contain ANSI foreground colors.
        assert.equal(/\u001b\[(?:3[0-7]|38;)/.test(row), false);
      }
    }
  });

  it('should wrap under the explanation column without losing words or explicit paragraphs', () => {
    const message =
      'Restore the configured file before retrying this operation.\n\nKeep all remediation words.';
    const rows = renderCliLifecycleTable(
      lifecycleTableLines([{ component: 'git', status: 'blocked', message }]),
      '/workspace',
      plainStyles,
      40,
    ).slice(0, -2);
    const offset = 'git  blocked  '.length;
    assert.ok(rows.length > 3);
    assert.ok(rows.every((row) => stringWidth(row) <= 40));
    assert.ok(rows.slice(1).every((row) => row.startsWith(' '.repeat(offset))));
    assert.equal(
      rows
        .map((row) => row.slice(offset))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
      message.replace(/\s+/g, ' '),
    );
    assert.ok(rows.includes(' '.repeat(offset)));
  });

  it('should stack explanations when a useful third column does not fit', () => {
    const message = 'Use native tools and restrict generic execution.';
    const rows = renderCliLifecycleTable(
      lifecycleTableLines([{ component: 'github-notifications', status: 'manual', message }]),
      '/workspace',
      plainStyles,
      40,
    );
    assert.equal(rows[0], 'github-notifications  manual');
    assert.ok(rows.slice(1, -2).every((row) => row.startsWith('  ') && stringWidth(row) <= 40));
    assert.equal(
      rows
        .slice(1, -2)
        .map((row) => row.trim())
        .join(' '),
      message,
    );
  });

  it('should preserve oversized tokens and keep even very narrow headers readable', () => {
    const token = '/workspace/a-very-long-unbroken-file-name';
    for (const columns of [12, 40, 80]) {
      const rows = renderCliLifecycleTable(
        lifecycleTableLines([
          { component: 'github-notifications', status: 'manual', message: token },
        ]),
        '/workspace',
        plainStyles,
        columns,
      ).slice(0, -2);
      assert.ok(rows.every((row) => stringWidth(row) <= columns));
      assert.equal(rows.join('').replace(/\s/g, ''), `github-notificationsmanual${token}`);
    }
  });

  it('should measure terminal cells rather than code units', () => {
    const rows = renderCliLifecycleTable(
      lifecycleTableLines([
        { component: '工具', status: 'healthy', message: '检查 café e\u0301 ready' },
        { component: 'path', status: 'healthy', message: 'Path ready' },
      ]),
      '/workspace',
      plainStyles,
      80,
    );
    assert.equal(rows[0]!.indexOf('healthy'), 4);
    assert.equal(rows[1]!.indexOf('healthy'), 6);
    assert.equal(stringWidth(rows[0]!.slice(0, rows[0]!.indexOf('healthy'))), 6);
    assert.ok(rows[0]!.endsWith('检查 café e\u0301 ready'.normalize()));
  });

  it('should use a deterministic width when terminal width is absent or invalid', () => {
    const lines = lifecycleTableLines(doctorFindings);
    const expected = renderCliLifecycleTable(lines, '/workspace', plainStyles, 80);
    for (const columns of [undefined, 0, -1, NaN, Infinity]) {
      assert.deepEqual(
        renderCliLifecycleTable(lines, '/workspace', plainStyles, columns),
        expected,
      );
    }
    assert.deepEqual(renderCliLifecycleTable([], '/workspace', plainStyles), [
      'workspace  /workspace',
    ]);
  });
});
