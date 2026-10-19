import assert from 'node:assert/strict';

import parse from '../agent/codex-runtime-request.ts';

describe('agent/codex-runtime-request', () => {
  it('should expose each workflow effect without moving request data into argv', () => {
    for (const [route, action] of [
      ['dispatch', 'context'],
      ['continuation', 'result'],
      ['feedback', 'publish'],
      ['delivery', 'prepare'],
      ['delivery', 'publish'],
      ['delivery', 'announce'],
    ]) {
      assert.deepEqual(
        parse(route!, [action!, '--plugin-data', '/private/plugin'], {
          id: 'receipt',
          body: 'draft',
        }),
        {
          pluginData: '/private/plugin',
          request: { id: 'receipt', body: 'draft', action },
        },
      );
    }
  });
  it('should expose nested publication and summary operations', () => {
    assert.deepEqual(
      parse('continuation', ['delivery', 'publish', '--plugin-data', '/private/plugin'], {
        id: 'receipt',
        delivery: { digest: 'digest' },
      }).request,
      {
        id: 'receipt',
        action: 'delivery',
        delivery: { action: 'publish', digest: 'digest' },
      },
    );
    assert.deepEqual(
      parse('dispatch', ['summary', 'compose', '--plugin-data', '/private/plugin'], {
        id: 'receipt',
      }).request,
      { id: 'receipt', action: 'summary', operation: 'compose' },
    );
  });
  it('should reject hidden action substitution before runtime or credential access', () => {
    for (const [route, args, request] of [
      ['delivery', ['prepare', '--plugin-data', '/private/plugin'], { action: 'publish' }],
      [
        'continuation',
        ['delivery', 'prepare', '--plugin-data', '/private/plugin'],
        { delivery: { action: 'publish' } },
      ],
      [
        'dispatch',
        ['summary', 'compose', '--plugin-data', '/private/plugin'],
        { operation: 'publish' },
      ],
    ] as const)
      assert.throws(() => parse(route, [...args], request), /workflow-command-action-mismatch/);
  });
  it('should reject unsupported commands extra arguments and missing nested operations', () => {
    for (const [route, args] of [
      ['delivery', ['merge', '--plugin-data', '/private/plugin']],
      ['delivery', ['prepare', 'extra', '--plugin-data', '/private/plugin']],
      ['delivery', ['prepare', '--plugin-data', '/private/plugin', 'extra']],
      ['continuation', ['delivery', '--plugin-data', '/private/plugin']],
      ['dispatch', ['summary', '--plugin-data', '/private/plugin']],
    ] as const)
      assert.throws(() => parse(route, [...args], {}), /workflow-command-/);
  });
  it('should preserve legacy saved requests without changing their effect', () => {
    const request = {
      action: 'delivery',
      id: 'receipt',
      delivery: { action: 'publish', digest: 'digest' },
    };
    assert.deepEqual(parse('continuation', ['--plugin-data', '/private/plugin'], request), {
      pluginData: '/private/plugin',
      request,
    });
  });
});
