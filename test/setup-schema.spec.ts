import assert from 'node:assert/strict';

import { parse, stringify } from 'yaml';

import {
  normalizeAgentSetup,
  setupDefaultTimeoutSeconds,
  setupMaximumTimeoutSeconds,
} from '../manifest/setup-schema.ts';
import parseAgentManifest from '../manifest/parse.ts';

function normalized(value: unknown) {
  const result = normalizeAgentSetup(value);
  assert.equal(result.status, 'valid', JSON.stringify(result.diagnostics));
  if (result.status !== 'valid') throw new Error('Expected valid setup.');
  return result.setup;
}

function invalid(value: unknown, code: string, fieldPath: string) {
  const result = normalizeAgentSetup(value);
  assert.equal(result.status, 'invalid');
  assert.ok(
    result.diagnostics.some((item) => item.code === code && item.fieldPath === fieldPath),
    JSON.stringify(result.diagnostics),
  );
}

describe('manifest/setup-schema', () => {
  it('should normalize equivalent shell layouts to the default step', () => {
    const expected = {
      steps: [
        {
          id: 'default',
          apply: {
            kind: 'shell',
            script: 'brew bundle --file=Brewfile',
            shell: 'sh',
            timeoutSeconds: 300,
          },
        },
      ],
    };
    for (const input of [
      'brew bundle --file=Brewfile',
      { apply: 'brew bundle --file=Brewfile' },
      { shell: 'sh', steps: [{ id: 'default', apply: 'brew bundle --file=Brewfile' }] },
    ])
      assert.deepEqual(normalized(input), expected);
  });

  it('should preserve yaml script contents without interpolation or trimming', () => {
    const input = parse('setup: |\n  echo "$HOME"\n  false | true\n');
    assert.deepEqual(normalized(input.setup).steps[0]?.apply, {
      kind: 'shell',
      script: 'echo "$HOME"\nfalse | true\n',
      shell: 'sh',
      timeoutSeconds: 300,
    });
    const source = '  printf "%s" "$(whoami)"  \n';
    assert.equal(normalized(source).steps[0]?.apply.kind, 'shell');
    assert.deepEqual(normalized(source), normalized({ apply: source }));
    assert.equal((normalized(source).steps[0]?.apply as { script: string }).script, source);
  });

  it('should preserve direct arguments and normalize arrays and objects equally', () => {
    const args = ['check', '', '$HOME', 'two words', '|', 'line\nbreak'];
    const expected = { kind: 'exec', executable: './scripts/setup', args, timeoutSeconds: 300 };
    assert.deepEqual(normalized({ apply: ['./scripts/setup', ...args] }).steps[0]?.apply, expected);
    assert.deepEqual(
      normalized({ apply: { command: './scripts/setup', args } }).steps[0]?.apply,
      expected,
    );
    assert.deepEqual(normalized({ apply: { command: '/usr/bin/true' } }).steps[0]?.apply, {
      kind: 'exec',
      executable: '/usr/bin/true',
      args: [],
      timeoutSeconds: 300,
    });
  });

  it('should preserve step order and inherit shells only for shell commands', () => {
    const setup = normalized({
      shell: 'bash',
      steps: [
        { id: 'brew-dependencies', check: 'brew bundle check', apply: ['brew', 'bundle'] },
        { id: 'workspace', shell: 'zsh', apply: 'configure && verify', check: 'verify' },
        { id: 'plugins', shell: 'sh', apply: 'configure-plugins' },
      ],
    });
    assert.deepEqual(
      setup.steps.map(({ id }) => id),
      ['brew-dependencies', 'workspace', 'plugins'],
    );
    assert.deepEqual(
      setup.steps.map(({ apply }) => (apply.kind === 'shell' ? apply.shell : apply.kind)),
      ['exec', 'zsh', 'sh'],
    );
    assert.deepEqual(setup.steps[0]?.check, {
      kind: 'shell',
      script: 'brew bundle check',
      shell: 'bash',
      timeoutSeconds: 300,
    });
    assert.deepEqual(setup.steps[1]?.check, {
      kind: 'shell',
      script: 'verify',
      shell: 'zsh',
      timeoutSeconds: 300,
    });
    assert.equal(Object.hasOwn(setup.steps[2] ?? {}, 'check'), false);
    assert.equal(
      (normalized({ shell: 'zsh', apply: 'true' }).steps[0]?.apply as { shell: string }).shell,
      'zsh',
    );
  });

  it('should bound explicit timeouts and supply the shared default', () => {
    assert.equal(setupDefaultTimeoutSeconds, 300);
    assert.equal(setupMaximumTimeoutSeconds, 3_600);
    for (const timeout of [1, 3_600]) {
      assert.equal(
        normalized({ apply: { command: 'true', 'timeout-seconds': timeout } }).steps[0]?.apply
          .timeoutSeconds,
        timeout,
      );
    }
    for (const timeout of [0, -1, 3_601, 1.5, '30', null]) {
      invalid(
        { apply: { command: 'true', 'timeout-seconds': timeout } },
        'manifest-schema',
        '/setup/apply/timeout-seconds',
      );
    }
  });

  it('should reject missing apply, mixed layouts, and duplicate step ids', () => {
    invalid({ check: 'true' }, 'manifest-required-key', '/setup/apply');
    invalid(
      { steps: [{ id: 'one', check: 'true' }] },
      'manifest-required-key',
      '/setup/steps/0/apply',
    );
    invalid({ steps: [], apply: 'true' }, 'manifest-setup-mixed-forms', '/setup');
    invalid({ steps: [], check: 'true' }, 'manifest-setup-mixed-forms', '/setup');
    invalid(
      {
        steps: [
          { id: 'one', apply: 'true' },
          { id: 'one', apply: 'true' },
        ],
      },
      'manifest-setup-duplicate-id',
      '/setup/steps/1/id',
    );
    for (const id of ['', 'Upper', '-first', 'last-', 'two--parts', 'two_parts', 'one\n']) {
      invalid({ steps: [{ id, apply: 'true' }] }, 'manifest-schema', '/setup/steps/0/id');
    }
  });

  it('should reject empty or malformed commands and unsupported forms', () => {
    for (const value of [null, false, 42, [], ['true'], {}, { command: 'true' }]) {
      assert.equal(normalizeAgentSetup(value).status, 'invalid');
    }
    for (const command of [
      '',
      ' \n\t ',
      'echo\0secret',
      [],
      [''],
      ['true', null],
      ['true', '\0'],
      { command: '' },
      { command: 'true\0' },
      { command: 'true\n' },
      { command: 'true', args: 'arg' },
    ]) {
      assert.equal(
        normalizeAgentSetup({ apply: command }).status,
        'invalid',
        JSON.stringify(command),
      );
    }
    invalid({ steps: [] }, 'manifest-schema', '/setup/steps');
    invalid({ shell: 'fish', apply: 'true' }, 'manifest-schema', '/setup/shell');
    invalid({ shell: 'bash {0}', apply: 'true' }, 'manifest-schema', '/setup/shell');
    invalid({ apply: { run: 'true' } }, 'manifest-unknown-key', '/setup/apply/run');
  });

  it('should report unknown fields with escaped paths without leaking their values', () => {
    const result = normalizeAgentSetup({ apply: { command: 'true', 'raw/key~': 'secret-value' } });
    assert.deepEqual(
      result.diagnostics.map(({ code, fieldPath, severity }) => ({ code, fieldPath, severity })),
      [
        {
          code: 'manifest-unknown-key',
          fieldPath: '/setup/apply/raw~1key~0',
          severity: 'error',
        },
      ],
    );
    assert.equal(JSON.stringify(result.diagnostics).includes('secret-value'), false);
    invalid({ apply: 'true', extra: true }, 'manifest-unknown-key', '/setup/extra');
    invalid(
      { steps: [{ id: 'one', apply: 'true', extra: true }] },
      'manifest-unknown-key',
      '/setup/steps/0/extra',
    );
  });

  it('should reject lexical path escapes without inspecting files or shell text', () => {
    for (const executable of [
      '../setup',
      './scripts/../setup',
      '/tmp/../setup',
      '.',
      'scripts\\setup',
    ]) {
      invalid({ apply: [executable] }, 'manifest-setup-unsafe-path', '/setup/apply/0');
      invalid(
        { steps: [{ id: 'one', apply: 'true', check: { command: executable } }] },
        'manifest-setup-unsafe-path',
        '/setup/steps/0/check/command',
      );
    }
    assert.equal(normalized({ apply: ['./does-not-exist', '$HOME'] }).steps[0]?.apply.kind, 'exec');
    assert.equal(normalized('source ../operator-script').steps[0]?.apply.kind, 'shell');
  });

  it('should return independent normalized values without mutating the input', () => {
    const args = Object.freeze(['apply']);
    const input = Object.freeze({ apply: Object.freeze({ command: './setup', args }) });
    const result = normalized(input);
    const command = result.steps[0]?.apply;
    assert.equal(command?.kind, 'exec');
    if (command?.kind === 'exec') command.args.push('changed');
    assert.deepEqual(args, ['apply']);
    assert.deepEqual(normalized(input).steps[0]?.apply, {
      kind: 'exec',
      executable: './setup',
      args: ['apply'],
      timeoutSeconds: 300,
    });
  });

  it('should accept every supported public form and preserve setup diagnostic paths', () => {
    for (const setup of [
      'echo simple',
      'echo one\necho two\n',
      { shell: 'zsh', apply: 'echo script' },
      {
        check: ['test', '-d', 'repo'],
        apply: { command: './setup', args: ['apply'], 'timeout-seconds': 30 },
      },
      {
        shell: 'bash',
        steps: [
          { id: 'first', check: 'test -f ready', apply: 'touch ready' },
          { id: 'second', shell: 'zsh', apply: 'true' },
        ],
      },
    ]) {
      const result = parseAgentManifest(
        stringify({ 'schema-version': 1, agent: { id: 'test' }, setup }),
      );
      assert.equal(result.status, 'valid');
      if (result.status === 'valid') assert.deepEqual(result.manifest.setup, normalized(setup));
    }
    const setup = {
      steps: [
        { id: 'duplicate', apply: 'private-command' },
        { id: 'duplicate', apply: 'private-command' },
      ],
    };
    const result = parseAgentManifest(
      stringify({ 'schema-version': 1, agent: { id: 'test' }, setup }),
    );
    assert.equal(result.status, 'invalid');
    assert.ok(
      result.diagnostics.some(
        ({ code, fieldPath }) =>
          code === 'manifest-setup-duplicate-id' && fieldPath === '/setup/steps/1/id',
      ),
    );
    assert.doesNotMatch(JSON.stringify(result.diagnostics), /private-command/u);
  });

  it('should normalize setup through the public manifest parser', () => {
    const result = parseAgentManifest('schema-version: 1\nagent:\n  id: test\nsetup: echo ready\n');
    assert.equal(result.status, 'valid');
    if (result.status === 'valid')
      assert.deepEqual(result.manifest.setup, normalized('echo ready'));
  });
});
