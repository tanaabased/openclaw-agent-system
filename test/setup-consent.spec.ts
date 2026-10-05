import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import ansis from 'ansis';
import stringWidth from 'fast-string-width';

import installAgentSystem from '../cli/install.ts';
import confirmSetupInstall, { type SetupConsentOptions } from '../cli/setup-consent.ts';
import { normalizeAgentSetup } from '../manifest/setup-schema.ts';

const normalized = normalizeAgentSetup({
  shell: 'zsh',
  check: 'test -e private-marker',
  apply: 'echo private-script',
});
assert.equal(normalized.status, 'valid');
const setup = normalized.setup;

function fixture(overrides: Partial<SetupConsentOptions> = {}) {
  const events: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const input = Object.assign(Readable.from([]), { isTTY: true });
  const options: SetupConsentOptions = {
    runtime: 'openclaw',
    setup,
    workspaceDir: '/workspace',
    environment: { NO_COLOR: '1' },
    input,
    output: {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
    prompt: async () => {
      events.push('prompt');
      return true;
    },
    ...overrides,
  };
  return {
    options,
    events,
    stdout,
    stderr,
    exitCodes,
    async install(json = false) {
      await installAgentSystem({
        ...options,
        json,
        setExitCode: (code) => exitCodes.push(code),
        manifestService: {
          async loadForCommandDirectory() {
            events.push('validate');
            return {
              status: 'loaded',
              path: '/workspace/agent.yaml',
              digest: 'test',
              diagnostics: [],
              validationChecks: [],
              scope: { workspaceDir: '/workspace' },
              manifest: {
                schemaVersion: 1,
                agent: { id: 'emori' },
                ...(options.setup ? { setup: options.setup } : {}),
                ...(options.setupHost ? { setupHost: options.setupHost } : {}),
              },
            };
          },
        },
        installService: {
          async install(input) {
            assert.equal(input.runtime, 'openclaw');
            events.push(
              input.skipSetupHost && input.skipSetupAgent ? 'install:skip' : 'install:apply',
            );
            return {
              agentId: 'emori',
              workspaceDir: '/workspace',
              outcomes:
                input.skipSetupHost && input.skipSetupAgent
                  ? []
                  : [
                      {
                        component: 'setup',
                        stepId: 'default',
                        status: 'updated',
                        code: 'setup-applied',
                        message: 'Setup step default',
                      },
                    ],
              warnings:
                input.skipSetupHost && input.skipSetupAgent
                  ? [{ component: 'setup', code: 'setup-skipped', message: 'Setup skipped' }]
                  : [],
            };
          },
        },
      });
    },
  };
}

describe('cli/setup-consent', () => {
  it('should style the preview without changing its wording or command details', async () => {
    const host = normalizeAgentSetup({
      steps: [
        { id: 'brew-dependencies', check: ['brew', 'list'], apply: ['brew', 'install', 'jq'] },
      ],
    });
    assert.equal(host.status, 'valid');
    const colored = fixture({ setupHost: host.setup, environment: { FORCE_COLOR: '3' } });
    const plain = fixture({
      setupHost: host.setup,
      environment: { NO_COLOR: '', FORCE_COLOR: '3' },
    });
    await confirmSetupInstall(colored.options);
    await confirmSetupInstall(plain.options);
    const preview = colored.stderr.join('');
    assert.ok(preview.includes('\u001b[38;2;0;200;138msetup-host:'));
    assert.ok(preview.includes('\u001b[38;2;226;82;146msetup-agent:'));
    assert.ok(preview.includes('\u001b[1mbrew-dependencies\u001b[22m'));
    assert.ok(preview.includes('\u001b[1m/workspace\u001b[22m'));
    assert.ok(preview.includes('check \u001b[2m(argv,'));
    assert.ok(preview.includes('apply \u001b[2m(argv,'));
    assert.equal(ansis.strip(preview), plain.stderr.join(''));
    assert.equal(plain.stderr.join('').includes('\u001b'), false);
    assert.equal(
      plain.stderr.join('').replace(/^[^ ]+ /u, ''),
      [
        'Install workspace "/workspace" with these setup steps:',
        '  setup-host: brew-dependencies',
        '    check (argv, 600s: ["brew","list"])',
        '    apply (argv, 600s: ["brew","install","jq"])',
        '  setup-agent: default',
        '    check (zsh, 600s: "test -e private-marker")',
        '    apply (zsh, 600s: "echo private-script")',
        '',
      ].join('\n'),
    );
  });

  it('should preview host setup before agent setup', async () => {
    const host = normalizeAgentSetup({ check: 'host check', apply: 'host apply' });
    assert.equal(host.status, 'valid');
    if (host.status !== 'valid') return;
    const test = fixture({ setupHost: host.setup });
    assert.equal(await confirmSetupInstall(test.options), true);
    const preview = test.stderr.join('');
    assert.ok(preview.indexOf('setup-host: default') < preview.indexOf('setup-agent: default'));
    assert.match(preview, /host apply/u);
    assert.match(preview, /private-script/u);
  });

  it('should wrap narrow previews without dropping command payloads', async () => {
    const script = 'printf "  keep spaces  " ' + 'long-token-'.repeat(12);
    const long = normalizeAgentSetup({ steps: [{ id: 'long-command', apply: script }] });
    assert.equal(long.status, 'valid');
    for (const columns of [32, 48]) {
      const test = fixture({
        setup: long.setup,
        environment: { FORCE_COLOR: '3' },
        terminalColumns: columns,
      });
      await confirmSetupInstall(test.options);
      const lines = test.stderr.join('').trimEnd().split('\n');
      assert.ok(lines.every((line) => stringWidth(line) <= columns));
      const plain = lines.map((line) => ansis.strip(line));
      const start = plain.findIndex((line) => line.startsWith('    apply '));
      assert.notEqual(start, -1);
      assert.equal(
        plain
          .slice(start)
          .map((line) => line.slice(4))
          .join(''),
        `apply (sh, 600s: ${JSON.stringify(script)})`,
      );
    }
  });

  it('should request the standard confirmation with no selected by default', async () => {
    const test = fixture({
      prompt: async (options) => {
        assert.deepEqual(options, {
          message: 'Continue with installation?',
          initialValue: false,
        });
        return true;
      },
    });
    assert.equal(await confirmSetupInstall(test.options), true);
  });

  it('should preview only the selected setup phase', async () => {
    const host = normalizeAgentSetup({ check: 'host check', apply: 'host apply' });
    assert.equal(host.status, 'valid');
    if (host.status !== 'valid') return;
    for (const selection of [
      { skipSetupHost: true, skipped: 'host apply', included: 'private-script' },
      { skipSetupAgent: true, skipped: 'private-script', included: 'host apply' },
    ]) {
      const test = fixture({ setupHost: host.setup, ...selection });
      assert.equal(await confirmSetupInstall(test.options), true);
      assert.deepEqual(test.events, ['prompt']);
      assert.doesNotMatch(test.stderr.join(''), new RegExp(selection.skipped, 'u'));
      assert.match(test.stderr.join(''), new RegExp(selection.included, 'u'));
    }
  });

  it('should preview only applicable steps and require no prompt when none apply', async () => {
    for (const runtime of ['openclaw', 'codex'] as const) {
      const filtered = normalizeAgentSetup({
        steps: [
          { id: 'shared', apply: 'shared command' },
          { id: 'selected', runtimes: [runtime], apply: 'selected command' },
          {
            id: 'excluded',
            runtimes: [runtime === 'openclaw' ? 'codex' : 'openclaw'],
            apply: 'private excluded command',
          },
        ],
      });
      assert.equal(filtered.status, 'valid');
      const test = fixture({ runtime, setup: filtered.setup });
      assert.equal(await confirmSetupInstall(test.options), true);
      assert.deepEqual(test.events, ['prompt']);
      assert.match(test.stderr.join(''), /shared command/u);
      assert.match(test.stderr.join(''), /selected command/u);
      assert.doesNotMatch(test.stderr.join(''), /excluded/u);
      const skipped = fixture({ runtime, setup: { steps: [filtered.setup.steps[2]!] } });
      assert.equal(await confirmSetupInstall(skipped.options), true);
      assert.deepEqual(skipped.events, []);
      assert.deepEqual(skipped.stderr, []);
    }
  });

  it('should select openclaw explicitly at the install boundary', async () => {
    const filtered = normalizeAgentSetup({ runtimes: ['codex'], apply: 'private codex command' });
    assert.equal(filtered.status, 'valid');
    const test = fixture({
      runtime: 'codex',
      setup: filtered.setup,
      environment: { CODEX_HOME: '/codex', AGENT_SYSTEM_RUNTIME: 'codex' },
    });
    await test.install(true);
    assert.deepEqual(test.events, ['validate', 'install:apply']);
    assert.deepEqual(test.stderr, []);
  });

  it('should confirm before installation even in json mode and keep the preview on stderr', async () => {
    const test = fixture({ environment: { FORCE_COLOR: '3' } });
    await test.install(true);
    assert.deepEqual(test.events, ['validate', 'prompt', 'install:apply']);
    assert.match(test.stderr.join(''), /private-script/u);
    assert.match(test.stderr.join(''), /zsh/u);
    assert.doesNotMatch(test.stdout.join(''), /private-script|private-marker/u);
    assert.equal(test.stdout.join('').includes('\u001b'), false);
    assert.equal(JSON.parse(test.stdout.join('')).outcomes[0].stepId, 'default');
  });

  it('should stop before mutations on decline, cancellation, or prompt failure', async () => {
    for (const answer of [
      false,
      Symbol('cancelled'),
      new Error('Setup cancelled'),
      new Error('private failure'),
    ]) {
      const test = fixture({
        prompt: async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      });
      await test.install(true);
      assert.deepEqual(test.events, ['validate']);
      assert.deepEqual(test.exitCodes, [1]);
      assert.equal(test.stdout.length, 0);
      assert.match(test.stderr.join(''), /code=setup-declined/u);
      assert.doesNotMatch(test.stderr.join(''), /private failure/u);
    }
  });

  it('should accept boolean switches and noninteractive stdin without a command preview', async () => {
    for (const overrides of [
      { yes: true },
      { nonInteractive: true },
      { input: Readable.from([]) },
    ]) {
      const test = fixture(overrides);
      await test.install(true);
      assert.deepEqual(test.events, ['validate', 'install:apply']);
      assert.deepEqual(test.stderr, []);
      assert.doesNotMatch(test.stdout.join(''), /private-script/u);
    }
  });

  it('should interpret only the enabled environment spellings as consent', async () => {
    for (const name of ['CI', 'NONINTERACTIVE']) {
      for (const value of ['1', 'true', 'yes', 'on', ' YeS ', ' TRUE ', 'ON']) {
        const test = fixture({ environment: { [name]: value } });
        assert.equal(await confirmSetupInstall(test.options), true);
        assert.deepEqual(test.events, []);
      }
      for (const value of [undefined, '', '0', 'false', 'no', 'off', 'anything']) {
        const test = fixture({ environment: { [name]: value } });
        assert.equal(await confirmSetupInstall(test.options), true);
        assert.deepEqual(test.events, ['prompt']);
      }
    }
    const test = fixture({ environment: { CI: 'false', NONINTERACTIVE: '1' } });
    await confirmSetupInstall(test.options);
    assert.deepEqual(test.events, []);
  });

  it('should let skip win over consent and return one json result with a visible warning', async () => {
    const test = fixture({
      skipSetup: true,
      yes: true,
      nonInteractive: true,
      environment: { CI: '1' },
    });
    await test.install(true);
    assert.deepEqual(test.events, ['validate', 'install:skip']);
    assert.equal(JSON.parse(test.stdout.join('')).warnings[0].code, 'setup-skipped');
    assert.equal(test.stderr.length, 1);
    assert.match(test.stderr.join(''), /Warning.*skipped/u);
    assert.doesNotMatch(test.stderr.join(''), /private-script/u);
  });

  it('should leave no-setup installation free of prompts and setup warnings', async () => {
    const test = fixture({ setup: undefined, skipSetup: true });
    assert.equal(await confirmSetupInstall(test.options), true);
    assert.deepEqual(test.events, []);
    assert.deepEqual(test.stderr, []);
  });

  it('should escape terminal control characters in the deliberate preview', async () => {
    const unsafe = normalizeAgentSetup('echo "\u001b[2J"\nexit 0');
    assert.equal(unsafe.status, 'valid');
    const test = fixture({ setup: unsafe.setup });
    await confirmSetupInstall(test.options);
    assert.equal(test.stderr.join('').includes(String.fromCharCode(27)), false);
    assert.match(test.stderr.join(''), /\\u001b/u);
    const colored = fixture({ setup: unsafe.setup, environment: { FORCE_COLOR: '3' } });
    await confirmSetupInstall(colored.options);
    assert.equal(colored.stderr.join('').includes('\u001b[2J'), false);
    assert.match(colored.stderr.join(''), /\\u001b\[2J/u);
  });
});
