import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import parseAgentManifest from '../manifest/parse.ts';

const Leia = createRequire(import.meta.url)('@lando/leia') as new () => {
  parse(files: string[]): Array<{ tests: Record<string, Array<{ command: string }>> }>;
};

describe('google example workflow', () => {
  it('should run live tasks through the standard example matrix without a model', async () => {
    const workflow = parse(await readFile('.github/workflows/pr-examples-tests.yml', 'utf8'));
    assert.ok(workflow.on.pull_request !== undefined);
    assert.equal(workflow.on.workflow_dispatch, undefined);
    assert.deepEqual(Object.keys(workflow.jobs), ['examples']);
    assert.ok(workflow.jobs.examples.strategy.matrix.example.includes('google'));
    assert.deepEqual(workflow.jobs.examples.strategy.matrix.os, ['macos-26', 'ubuntu-24.04']);
    assert.equal(workflow.permissions.contents, 'read');
    const steps = workflow.jobs.examples.steps as Array<{
      name: string;
      if?: string;
      env?: Record<string, string>;
      run?: string;
    }>;
    assert.ok(!steps.some((step) => step.name === 'Install reviewed GoG'));
    const pathStep = steps.findIndex((step) => step.name === 'PATH updates');
    const brewStep = steps.findIndex((step) => step.name === 'Brew updates');
    assert.ok(pathStep >= 0 && brewStep > pathStep);
    assert.match(steps[pathStep]?.run ?? '', /\/home\/linuxbrew\/\.linuxbrew\/bin/u);
    const run = steps.find((step) => step.name === 'Run Leia-backed example');
    assert.equal(run?.env?.OP_SERVICE_ACCOUNT_TOKEN, '${{ secrets.TANAAB_OP_TESTVAULT }}');
    assert.equal(
      run?.env?.DBUS_SESSION_BUS_ADDRESS,
      'unix:path=${{ runner.temp }}/secret-service-bus',
    );
    assert.equal(run?.env?.GOG_HOME, '${{ runner.temp }}/google-gog');
    assert.equal(
      run?.run,
      'bun run leia "examples/${{ matrix.example }}/README.md" --stdin --retry 0',
    );
    const fixture = parseAgentManifest(await readFile('examples/google/agent.yaml', 'utf8'));
    assert.equal(fixture.status, 'valid');
    if (fixture.status !== 'valid') throw new Error();
    assert.equal(fixture.manifest.google?.credentialEncoding, 'base64');
    assert.equal(fixture.manifest.google?.account, undefined);
    assert.equal(fixture.manifest.agent.name, 'Google Test');
    assert.deepEqual(fixture.manifest.agent.email, { fromEnvironment: 'GOG_ACCOUNT' });
    assert.deepEqual(fixture.manifest.environment?.op, ['jglytdfegfggijqkalco2cxexa']);
    assert.deepEqual(fixture.manifest.environment?.required, [
      'GOG_ACCOUNT',
      'GOG_CREDENTIALS_JSON_B64',
      'GOG_TOKEN_JSON_B64',
      'GOG_KEYRING_PASSWORD',
    ]);
    assert.equal(fixture.manifest.setupHost?.steps[0]?.id, 'gog-cli');
    assert.equal(fixture.manifest.setup, undefined);
    assert.deepEqual(fixture.manifest.setupHost?.steps[0]?.apply, {
      kind: 'shell',
      shell: 'sh',
      script:
        'brew tap openclaw/tap\nbrew trust --tap openclaw/tap\nbrew bundle install --file=Brewfile\n',
      timeoutSeconds: 600,
    });
    const brewfile = await readFile('examples/google/Brewfile', 'utf8');
    assert.match(brewfile, /tap "openclaw\/tap", trusted: true/u);
    assert.match(brewfile, /brew "openclaw\/tap\/gogcli"/u);
    const suites = new Leia().parse([resolve('examples/google/README.md')]);
    assert.equal(suites.length, 1);
    const commands = Object.values(suites[0]!.tests)
      .flat()
      .map(({ command }) => command)
      .join('\n');
    assert.match(commands, /--needs-secret-service/u);
    assert.match(commands, /credentials set op --from-env/u);
    assert.match(commands, /tasks lists list --max 1 --readonly/u);
    assert.match(commands, /google-credentials-unchanged/u);
    assert.match(commands, /index\("gog-cli"\) < index\("google"\)/u);
    assert.doesNotMatch(commands, /auth add|gcloud|gateway run|agent --/u);
  });
});
