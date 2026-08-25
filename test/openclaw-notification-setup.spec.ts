import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const command = 'scripts/openclaw-notification-setup';
const environment = { ...process.env, NO_COLOR: '1' };

describe('scripts/openclaw-notification-setup', () => {
  it('should document one provider-neutral notification setup surface', async () => {
    const { stdout } = await execFileAsync(command, ['--help'], { env: environment });

    assert.match(
      stdout,
      /Usage: openclaw-notification-setup <prepare\|evidence\|stop> --model <provider\/model>/u,
    );
    assert.match(stdout, /--scenario <id>/u);
    assert.match(stdout, /--expected-evidence <path>/u);
    assert.match(stdout, /OPENCLAW_NOTIFICATION_MODEL/u);
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
});
