import assert from 'node:assert/strict';

import ansis from 'ansis';

import {
  createCliStyles,
  renderCliSummary,
  writeCliJson,
  writeCliSummary,
} from '../lib/cli-output.ts';

const plainStyles = createCliStyles({ NO_COLOR: '1' });

describe('lib/cli-output', () => {
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
      { writeStdout: (value) => written.push(value) },
      [{ label: 'valid', style: 'status', value: 'Agent System manifest for data' }],
      plainStyles,
    );

    assert.deepEqual(written, ['valid  Agent System manifest for data\n']);
  });

  it('should keep json output undecorated', () => {
    const written: string[] = [];

    writeCliJson({ writeStdout: (value) => written.push(value) }, { agentId: 'data' });

    assert.deepEqual(written, ['{\n  "agentId": "data"\n}\n']);
  });
});
