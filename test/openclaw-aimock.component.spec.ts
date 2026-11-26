import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const command = 'scripts/openclaw-aimock';
const environment = { ...process.env, NO_COLOR: '1' };

describe('scripts/openclaw-aimock', () => {
  it('should document one strict mock provider lifecycle', async () => {
    const { stdout } = await execFileAsync(command, ['--help'], { env: environment });

    assert.match(stdout, /Usage: openclaw-aimock <prepare\|evidence\|stop>/u);
    assert.match(stdout, /--scenario <id>/u);
    assert.match(stdout, /--expected-evidence <path>/u);
    assert.match(stdout, /OPENCLAW_AIMOCK_MODEL/u);
  });

  it('should reject an unknown action before touching runtime state', async () => {
    await assert.rejects(
      execFileAsync(command, ['unknown'], { env: environment }),
      (error: unknown) => {
        assert.match(
          (error as { stderr?: string }).stderr ?? '',
          /an action of prepare, evidence, or stop is required/u,
        );
        return true;
      },
    );
  });

  it('should accept extra discovery reads and reject missing tool effects and failed requests', () => {
    const scenario = 'openclaw-credentials';
    const tool = { name: 'agent_system_git', callResponseCount: 5, resultRequestCount: 7 };
    const observed = {
      scenario,
      schemaVersion: 2,
      provider: 'aimock',
      model: 'aimock/gpt-5.5',
      requestCount: 19,
      successfulFixtureResponseCount: 19,
      strictMissCount: 0,
      promptRequestCount: 19,
      discoveryRequestCount: 8,
      finalResponseCount: 5,
      tools: [tool],
    };
    function check(overrides: Partial<typeof observed>) {
      return spawnSync(
        'jq',
        [
          '-e',
          '--arg',
          'scenario',
          scenario,
          '--slurpfile',
          'expected',
          `examples/${scenario}/expected-evidence.json`,
          '-f',
          'scripts/assert-aimock-evidence.jq',
        ],
        { input: JSON.stringify({ ...observed, ...overrides }), encoding: 'utf8' },
      );
    }
    const accepted = check({});
    assert.equal(accepted.status, 0, accepted.stderr);
    for (const invalid of [
      { tools: [] },
      { tools: [{ ...tool, resultRequestCount: 0 }] },
      { tools: [{ ...tool, callResponseCount: 6 }] },
      { finalResponseCount: 4 },
      { strictMissCount: 1 },
      { successfulFixtureResponseCount: 18 },
    ])
      assert.notEqual(check(invalid).status, 0);
  });

  it('should remain independent of an available live-model credential', async () => {
    const source = await readFile(command, 'utf8');

    assert.doesNotMatch(source, /OPENAI_API_KEY/u);
    assert.match(source, /aimock-server\.ts/u);
  });
});
