import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { parse } from 'yaml';
import parseAgentManifest from '../manifest/parse.ts';

const Leia = createRequire(import.meta.url)('@lando/leia') as new () => {
  parse(files: string[]): Array<{ tests: Record<string, Array<{ command: string }>> }>;
};

describe('google live workflow', () => {
  it('should reserve live credential access for manual dispatch without a model', async () => {
    const workflow = parse(await readFile('.github/workflows/pr-examples-tests.yml', 'utf8'));
    assert.equal(workflow.jobs.examples.if, "github.event_name == 'pull_request'");
    assert.equal(workflow.jobs['google-live'].if, "github.event_name == 'workflow_dispatch'");
    assert.equal(workflow.on.workflow_dispatch.inputs['google-account'].required, true);
    assert.equal(workflow.permissions.contents, 'read');
    const live = workflow.jobs['google-live'].steps.find(
      (step: { name: string }) => step.name === 'Run live Tasks example',
    );
    assert.equal(live.env.OP_SERVICE_ACCOUNT_TOKEN, '${{ secrets.TANAAB_OP_TESTVAULT }}');
    assert.equal(live.env.GOG_HOME, '${{ runner.temp }}/google-live-gog');
    assert.ok(!Object.keys(live.env).some((key) => /MODEL|OPENAI/u.test(key)));
    const fixture = parseAgentManifest(
      await readFile('examples/tool/google-live/agent.yaml', 'utf8'),
    );
    assert.equal(fixture.status, 'valid');
    if (fixture.status !== 'valid') throw new Error();
    assert.equal(fixture.manifest.google?.credentialEncoding, 'base64');
    assert.equal(fixture.manifest.google?.account, undefined);
    assert.deepEqual(fixture.manifest.environment?.required, [
      'GOG_CREDENTIALS_JSON_B64',
      'GOG_TOKEN_JSON_B64',
      'GOG_KEYRING_PASSWORD',
    ]);
    const suites = new Leia().parse([resolve('examples/tool/google-live/README.md')]);
    assert.equal(suites.length, 1);
    const commands = Object.values(suites[0]!.tests)
      .flat()
      .map(({ command }) => command)
      .join('\n');
    assert.match(commands, /tasks lists list --max 1 --readonly/u);
    assert.match(commands, /google-credentials-unchanged/u);
    assert.doesNotMatch(commands, /auth add|gcloud|gateway run|agent --/u);
  });
});
