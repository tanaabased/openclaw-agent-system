import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import parseAgentManifest from '../manifest/parse.ts';

const Leia = createRequire(import.meta.url)('@lando/leia') as new () => {
  parse(files: string[]): Array<{ tests: Record<string, Array<{ command: string }>> }>;
};

describe('google example workflow', () => {
  it('should retain the live google contract without a model through the packed plugin', async () => {
    const fixture = parseAgentManifest(
      await readFile('examples/openclaw-google/agent.yaml', 'utf8'),
    );
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
    const brewfile = await readFile('examples/openclaw-google/Brewfile', 'utf8');
    assert.match(brewfile, /tap "openclaw\/tap", trusted: true/u);
    assert.match(brewfile, /brew "openclaw\/tap\/gogcli"/u);
    const suites = new Leia().parse([resolve('examples/openclaw-google/README.md')]);
    assert.equal(suites.length, 1);
    const commands = Object.values(suites[0]!.tests)
      .flat()
      .map(({ command }) => command)
      .join('\n');
    assert.match(commands, /--store file/u);
    assert.match(commands, /credentials set op --from-env/u);
    assert.match(commands, /tasks lists list --max 1 --readonly/u);
    assert.match(commands, /google-credentials-unchanged/u);
    assert.match(commands, /index\("gog-cli"\) < index\("google"\)/u);
    assert.doesNotMatch(commands, /auth add|gcloud|gateway run|agent --/u);
  });
});
