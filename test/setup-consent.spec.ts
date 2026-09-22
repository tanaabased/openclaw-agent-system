import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

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
    setup,
    workspaceDir: '/workspace',
    environment: {},
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
              },
            };
          },
        },
        installService: {
          async install(input) {
            events.push(input.skipSetup ? 'install:skip' : 'install:apply');
            return {
              agentId: 'emori',
              workspaceDir: '/workspace',
              outcomes: input.skipSetup
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
              warnings: input.skipSetup
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
  it('should confirm before installation even in json mode and keep the preview on stderr', async () => {
    const test = fixture();
    await test.install(true);
    assert.deepEqual(test.events, ['validate', 'prompt', 'install:apply']);
    assert.match(test.stderr.join(''), /private-script/u);
    assert.match(test.stderr.join(''), /zsh/u);
    assert.doesNotMatch(test.stdout.join(''), /private-script|private-marker/u);
    assert.equal(JSON.parse(test.stdout.join('')).outcomes[0].stepId, 'default');
  });

  it('should stop before mutations on decline, cancellation, or prompt failure', async () => {
    for (const answer of [false, Symbol('cancelled'), new Error('private failure')]) {
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
  });
});
