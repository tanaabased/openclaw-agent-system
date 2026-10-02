import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

describe('scripts/openclaw-github-notifications', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-system-notification-helper-'));
    const openclaw = join(directory, 'openclaw');
    await writeFile(
      openclaw,
      [
        '#!/bin/sh',
        'if [ "$OPENCLAW_LOG_LEVEL" != error ]; then',
        '  printf "%s\\n" "[state/agent-db] agent database integrity gate"',
        'fi',
        'printf "%s\\n" "$TEST_NOTIFICATION_RESULT"',
        'printf "%s\\n" "fixture stderr diagnostic" >&2',
        '',
      ].join('\n'),
    );
    await chmod(openclaw, 0o700);
    const gateway = join(directory, 'openclaw-gateway');
    await writeFile(gateway, '#!/bin/sh\nexit 0\n');
    await chmod(gateway, 0o700);
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  function refresh(code: string) {
    return run(
      join(process.cwd(), 'scripts', 'openclaw-github-notifications'),
      ['refresh-completed', '--agent', 'fixture', '--timeout', '1'],
      {
        env: {
          ...process.env,
          GITHUB_ACTIONS: 'true',
          NO_COLOR: '1',
          OPENCLAW_DEBUG: '0',
          OPENCLAW_LOG_LEVEL: 'info',
          PATH: [directory, process.env.PATH].join(':'),
          TEST_NOTIFICATION_RESULT: JSON.stringify({
            agentId: 'fixture',
            code,
            status: 'completed',
          }),
          TMPDIR: directory,
        },
      },
    );
  }

  it('should preserve completed poll json when the host logs informational state messages', async () => {
    const result = await refresh('github-notification-poll-complete');

    assert.deepEqual(JSON.parse(result.stdout), {
      agentId: 'fixture',
      code: 'github-notification-poll-complete',
      status: 'completed',
    });
    assert.match(result.stderr, /fixture stderr diagnostic/u);
  });

  it('should still reject a result that does not prove a completed notification poll', async () => {
    await assert.rejects(refresh('unexpected-result'), (error: unknown) => {
      const failure = error as { code?: number; stderr?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? '', /did not complete a GitHub poll/u);
      return true;
    });
  });
});
