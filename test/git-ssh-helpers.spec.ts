import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

describe('bin/git ssh helpers', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'agent-system-git-ssh-helper-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it('should select the dedicated signing agent public key', async () => {
    const sshAdd = join(directory, 'ssh-add');
    await writeFile(
      sshAdd,
      '#!/bin/sh\n[ "$SSH_AUTH_SOCK" = "$EXPECTED_SOCKET" ] || exit 21\nprintf "%s\\n" "ssh-ed25519 AAAATEST agent-system"\n',
    );
    await chmod(sshAdd, 0o700);

    const result = await run(join(process.cwd(), 'bin', 'agent-system-ssh-signing-key'), [], {
      env: {
        ...process.env,
        AGENT_SYSTEM_SSH_ADD_EXECUTABLE: sshAdd,
        AGENT_SYSTEM_SSH_SIGNING_SOCKET: '/tmp/signing.sock',
        EXPECTED_SOCKET: '/tmp/signing.sock',
      },
    });

    assert.equal(result.stdout, 'key::ssh-ed25519 AAAATEST agent-system\n');
  });

  it('should delegate signing and verification to ssh-keygen with the dedicated socket', async () => {
    const sshKeygen = join(directory, 'ssh-keygen');
    await writeFile(
      sshKeygen,
      '#!/bin/sh\n[ "$SSH_AUTH_SOCK" = "$EXPECTED_SOCKET" ] || exit 22\nprintf "%s\\n" "$*"\n',
    );
    await chmod(sshKeygen, 0o700);

    const result = await run(
      join(process.cwd(), 'bin', 'agent-system-ssh-keygen'),
      ['-Y', 'sign', '-n', 'git'],
      {
        env: {
          ...process.env,
          AGENT_SYSTEM_SSH_KEYGEN_EXECUTABLE: sshKeygen,
          AGENT_SYSTEM_SSH_SIGNING_SOCKET: '/tmp/signing.sock',
          EXPECTED_SOCKET: '/tmp/signing.sock',
        },
      },
    );

    assert.equal(result.stdout, '-Y sign -n git\n');
  });
});
