import assert from 'node:assert/strict';

import parse from '../agent/codex-runtime-request.ts';

describe('agent/codex-runtime-request', () => {
  it('should carry saved preparation requests unchanged through each pr publication route', () => {
    const content = {
      digest: '67b745ba5d309191b215bc5c99c398434aa1a71fff8116e841a0a90deb3c49ce',
      title: 'A poem: "simple"',
      body: "one\n\ntwo `literal` $(literal) 'quoted' 🐓",
    };
    for (const [route, args, publishRequest] of [
      [
        'delivery',
        ['publish'],
        { action: 'publish', id: 'receipt', eventId: 'source', ...content },
      ],
      [
        'continuation',
        ['delivery', 'publish'],
        { action: 'delivery', id: 'receipt', delivery: { action: 'publish', ...content } },
      ],
      [
        'dispatch',
        ['implementation', 'publish'],
        {
          action: 'implementation',
          operation: 'delivery',
          deliveryOperation: 'publish',
          id: 'receipt',
          ...content,
        },
      ],
    ] as const) {
      const saved = JSON.stringify({
        status: 'prepared',
        operation: { head: 'observed-head' },
        instruction: 'inspect before publishing',
        publishRequest,
      });
      const parsed = parse(route, [...args, '--plugin-data', '/private/plugin'], JSON.parse(saved));
      assert.deepEqual(parsed.request, publishRequest);
      assert.deepEqual(JSON.parse(saved).publishRequest, publishRequest);
    }
  });

  it('should reject preparation envelopes that hide effects or do not contain a prepared publication', () => {
    const envelope = { status: 'prepared', publishRequest: { action: 'publish', id: 'receipt' } };
    for (const [route, args] of [
      ['delivery', []],
      ['delivery', ['prepare']],
      ['delivery', ['reconcile']],
      ['feedback', ['publish']],
      ['dispatch', ['summary', 'publish']],
    ] as const)
      assert.throws(
        () => parse(route, [...args, '--plugin-data', '/private/plugin'], envelope),
        /workflow-prepared-publication-invalid/,
      );
    for (const bad of [
      { ...envelope, status: 'error' },
      { ...envelope, publishRequest: null },
      { ...envelope, publishRequest: [] },
      { ...envelope, publishRequest: 'unparsed' },
    ])
      assert.throws(
        () => parse('delivery', ['publish', '--plugin-data', '/private/plugin'], bad),
        /workflow-prepared-publication-invalid/,
      );
    for (const [route, args, publishRequest] of [
      ['delivery', ['publish'], { action: 'prepare' }],
      ['delivery', ['publish'], {}],
      [
        'continuation',
        ['delivery', 'publish'],
        { action: 'delivery', delivery: { action: 'prepare' } },
      ],
      [
        'dispatch',
        ['implementation', 'publish'],
        { action: 'implementation', operation: 'context' },
      ],
    ] as const)
      assert.throws(
        () =>
          parse(route, [...args, '--plugin-data', '/private/plugin'], {
            ...envelope,
            publishRequest,
          }),
        /workflow-command-action-mismatch/,
      );
  });

  it('should expose each workflow effect without moving request data into argv', () => {
    for (const [route, action] of [
      ['dispatch', 'context'],
      ['dispatch', 'observe-denials'],
      ['continuation', 'result'],
      ['delivery', 'link'],
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
  it('should expose nested publication operations', () => {
    for (const operation of ['context', 'compose', 'candidate', 'publish', 'reconcile']) {
      assert.deepEqual(
        parse('feedback', ['reply', operation, '--plugin-data', '/private/plugin'], {
          target: 'https://github.com/owner/repo/issues/3',
        }).request,
        { action: 'reply', operation, target: 'https://github.com/owner/repo/issues/3' },
      );
    }
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
  });
  it('should reject hidden action substitution before runtime or credential access', () => {
    assert.throws(
      () =>
        parse('feedback', ['reply', 'compose', '--plugin-data', '/private/plugin'], {
          operation: 'publish',
        }),
      /workflow-command-action-mismatch/,
    );
    assert.throws(
      () => parse('feedback', ['reply', '--plugin-data', '/private/plugin'], {}),
      /workflow-command-operation-required/,
    );
    for (const [route, args, request] of [
      ['delivery', ['prepare', '--plugin-data', '/private/plugin'], { action: 'publish' }],
      [
        'continuation',
        ['delivery', 'prepare', '--plugin-data', '/private/plugin'],
        { delivery: { action: 'publish' } },
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
  it('should expose direct assessment operations and reject hidden or substituted operations', () => {
    for (const operation of ['context', 'render']) {
      assert.equal(
        parse('dispatch', ['assessment', operation, '--plugin-data', '/private/plugin'], {}).request
          .operation,
        operation,
      );
    }
    assert.throws(
      () =>
        parse('dispatch', ['--plugin-data', '/private/plugin'], {
          action: 'assessment',
          operation: 'context',
        }),
      /workflow-command-operation-required/,
    );
    assert.throws(
      () =>
        parse('dispatch', ['assessment', 'context', '--plugin-data', '/private/plugin'], {
          operation: 'result',
        }),
      /workflow-command-action-mismatch/,
    );
    assert.throws(
      () => parse('dispatch', ['assessment', 'publish', '--plugin-data', '/private/plugin'], {}),
      /workflow-command-operation-invalid/,
    );
  });
  it('should expose direct implementation and publication without hidden effect substitution', () => {
    for (const operation of ['context', 'result'])
      assert.equal(
        parse('dispatch', ['implementation', operation, '--plugin-data', '/private/plugin'], {})
          .request.operation,
        operation,
      );
    for (const operation of ['prepare', 'publish', 'reconcile', 'delivery-present']) {
      const request = parse(
        'dispatch',
        ['implementation', operation, '--plugin-data', '/private/plugin'],
        {},
      ).request;
      assert.equal(request.operation, 'delivery');
      assert.equal(
        request.deliveryOperation,
        operation === 'delivery-present' ? 'present' : operation,
      );
    }
    assert.throws(
      () =>
        parse('dispatch', ['implementation', 'prepare', '--plugin-data', '/private/plugin'], {
          deliveryOperation: 'publish',
        }),
      /workflow-command-action-mismatch/,
    );
    assert.throws(
      () =>
        parse('dispatch', ['implementation', 'context', '--plugin-data', '/private/plugin'], {
          operation: 'delivery',
        }),
      /workflow-command-action-mismatch/,
    );
    assert.throws(
      () =>
        parse('dispatch', ['--plugin-data', '/private/plugin'], {
          action: 'implementation',
          operation: 'context',
        }),
      /workflow-command-operation-required/,
    );
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
