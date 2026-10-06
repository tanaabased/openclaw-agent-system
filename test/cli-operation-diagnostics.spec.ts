import assert from 'node:assert/strict';

import automationOperation, { type AutomationCommandOptions } from '../cli/automation-output.ts';
import { writeBackupDiagnostics, writeBackupFailure } from '../cli/backup-output.ts';
import { BackupError } from '../agent/backup-types.ts';
import { createCliStyles } from '../cli/output.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

function output(json: boolean) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  return {
    json,
    stdout,
    stderr,
    exitCodes,
    output: {
      writeStdout: (value: string) => stdout.push(value),
      writeStderr: (value: string) => stderr.push(value),
    },
    styles: createCliStyles({ NO_COLOR: '1' }),
    setExitCode: (code: number) => exitCodes.push(code),
  };
}

const loaded: AgentManifestLoadResult = {
  status: 'loaded',
  scope: { workspaceDir: '/workspace' },
  path: '/workspace/agent.yaml',
  digest: 'abc',
  manifest: { schemaVersion: 1, agent: { id: 'data' } },
  diagnostics: [],
  validationChecks: [],
};

describe('cli/operation-diagnostics', () => {
  it('should distinguish backup coverage warnings from operation failures', () => {
    for (const json of [true, false]) {
      const test = output(json);
      writeBackupDiagnostics(test, [
        { code: 'backup-include-unmatched', message: 'No matching files.' },
      ]);
      assert.deepEqual(test.stdout, []);
      if (!json) assert.match(test.stderr.join(''), /Warning/u);
      writeBackupFailure(test, new BackupError('backup-failed', 'Cannot read archive.'));
      assert.deepEqual(test.exitCodes, [1]);
      if (json) assert.equal(JSON.parse(test.stdout.join('')).status, 'failed');
      else assert.match(test.stderr.join(''), /Error/u);
    }
  });

  it('should classify native skip reasons while preserving automation json and exit status', async () => {
    for (const [reason, label] of [
      ['not-due', 'Notice'],
      ['disabled', 'Notice'],
      ['already-running', 'Notice'],
      ['stopped', 'Warning'],
      ['invalid-spec', 'Error'],
    ]) {
      for (const json of [false, true]) {
        const test = output(json);
        const options = {
          ...test,
          workspaceDir: '/workspace',
          automations: {} as AutomationCommandOptions['automations'],
          manifestService: {
            loadForAgentId: async () => loaded,
            loadForCommandDirectory: async () => loaded,
          },
        };
        const result = { status: 'skipped', reason };
        await automationOperation(options, async () => result);
        assert.deepEqual(test.exitCodes, [1]);
        if (json) {
          assert.deepEqual(JSON.parse(test.stdout.join('')), result);
          assert.deepEqual(test.stderr, []);
        } else {
          assert.ok(test.stderr.join('').includes(label!));
          assert.equal(test.stdout.join(''), 'skipped\n');
        }
      }
    }
  });
});
