import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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

  it('should remain independent of an available live-model credential', async () => {
    const source = await readFile(command, 'utf8');

    assert.doesNotMatch(source, /OPENAI_API_KEY/u);
    assert.match(source, /aimock-server\.ts/u);
    assert.match(source, /strictMissCount == 0/u);
  });

  it('should give assignment classification a distinct default model', async () => {
    const source = await readFile(command, 'utf8');

    assert.match(source, /scenario" == 'assignment'/u);
    assert.match(source, /classifier_model_id="\$\{model_id\}-classifier"/u);
  });
});
