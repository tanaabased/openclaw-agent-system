import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  githubCliFixtureArgv,
  runCliFixture,
  type CliCapture,
  type CliExecutor,
} from '../scripts/cli-fixtures.ts';

const repository = 'tanaabased/big-test-bucket';

function result(stdout: string, exitCode = 0): CliCapture {
  return { exitCode, stderr: '', stdout, timedOut: false, truncated: false };
}

function fakeCli(output: string, failure?: 'invalid-flag' | 'timeout' | 'truncated'): CliExecutor {
  return (executable, argv) => {
    assert.equal(executable, 'gh');
    if (argv[0] === '--version') return result('gh version 2.0.0\n');
    if (argv[1] === 'user') return result('{"login":"pirog","nodeId":"U_current"}\n');
    if (argv[1] === `repos/${repository}`) {
      return result(`{"fullName":"${repository}","permissions":{"pull":true}}\n`);
    }
    if (argv[1] === `repos/${repository}/pulls/42` && argv.includes('{author:.user.login}')) {
      return result('{"author":"tanaabot"}\n');
    }
    if (failure === 'invalid-flag') return result('unknown flag: --invalid\n', 1);
    if (failure === 'timeout') return { ...result(''), timedOut: true };
    if (failure === 'truncated') return { ...result('['), truncated: true };
    return result(output);
  };
}

describe('scripts/cli-fixtures', () => {
  it('should record, accept, and repeatedly compare a sanitized author capture', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'cli-fixtures-'));
    const approved = join(fixtureDir, 'pr-author.approved.txt');
    try {
      const base = {
        author: 'tanaabot',
        caseId: 'pr-author' as const,
        fixtureDir,
        pr: 42,
        now: () => '2026-09-29T00:00:00.000Z',
      };
      const execute = fakeCli('{"nodeId":"REAL_NODE_ID"}\n');
      assert.match(runCliFixture({ ...base, action: 'record', execute }), /candidate/u);
      assert.match(
        runCliFixture({ action: 'accept', caseId: 'pr-author', fixtureDir }),
        /Accepted/u,
      );
      const initial = readFileSync(approved, 'utf8');
      assert.equal(JSON.parse(initial).stdout, '{"nodeId":"U_agent"}\n');
      const compare = (directory: string, name: string, contents: string) => {
        assert.equal(readFileSync(join(directory, `${name}.approved.txt`), 'utf8'), contents);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        assert.match(
          runCliFixture({ ...base, action: 'check', execute, verifyApproval: compare }),
          /Checked/u,
        );
      }
      assert.throws(
        () => runCliFixture({ ...base, action: 'check', execute: fakeCli('plain text\n') }),
        /not valid JSON/u,
      );
      writeFileSync(
        join(fixtureDir, 'pr-author.received.txt'),
        initial.replace('U_agent', 'U_other'),
      );
      assert.throws(
        () => runCliFixture({ action: 'accept', caseId: 'pr-author', fixtureDir }),
        /candidate is invalid/u,
      );
      assert.equal(readFileSync(approved, 'utf8'), initial);
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });

  it('should reject invalid flags and incomplete output before writing candidates', () => {
    for (const failure of ['invalid-flag', 'timeout', 'truncated'] as const) {
      const fixtureDir = mkdtempSync(join(tmpdir(), 'cli-fixtures-'));
      try {
        assert.throws(
          () =>
            runCliFixture({
              action: 'record',
              author: 'tanaabot',
              caseId: 'pr-author',
              execute: fakeCli('', failure),
              fixtureDir,
              pr: 42,
            }),
          /complete successful response/u,
        );
        assert.throws(
          () => readFileSync(join(fixtureDir, 'pr-author.received.txt'), 'utf8'),
          /ENOENT/u,
        );
      } finally {
        rmSync(fixtureDir, { force: true, recursive: true });
      }
    }
  });

  it('should preserve review page shape and reject a single page', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'cli-fixtures-'));
    try {
      const base = {
        action: 'record' as const,
        author: 'tanaabot',
        caseId: 'pr-reviews' as const,
        fixtureDir,
        pr: 42,
        reviewer: 'pirog',
      };
      const pages = [
        [{ state: 'PENDING', user: { login: 'pirog', node_id: 'PRIVATE' } }],
        [{ state: 'APPROVED', user: { login: 'pirog', node_id: 'PRIVATE' } }],
      ];
      runCliFixture({ ...base, execute: fakeCli(`${JSON.stringify(pages)}\n`) });
      const capture = JSON.parse(readFileSync(join(fixtureDir, 'pr-reviews.received.txt'), 'utf8'));
      assert.deepEqual(JSON.parse(capture.stdout), [
        [{ state: 'PENDING', user: { login: 'reviewer' } }],
        [{ state: 'APPROVED', user: { login: 'reviewer' } }],
      ]);
      assert.equal(capture.stdout.endsWith('\n'), true);
      assert.throws(
        () => runCliFixture({ ...base, execute: fakeCli(`${JSON.stringify([pages.flat()])}\n`) }),
        /at least two actual pages/u,
      );
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });

  it('should match the two production command shapes', () => {
    assert.deepEqual(githubCliFixtureArgv('pr-author', 'owner/repo', 4), [
      'api',
      'repos/owner/repo/pulls/4',
      '--jq',
      '{nodeId:.user.node_id}',
    ]);
    assert.deepEqual(githubCliFixtureArgv('pr-reviews', 'owner/repo', 4), [
      'api',
      'repos/owner/repo/pulls/4/reviews',
      '--paginate',
      '--slurp',
    ]);
    assert.deepEqual(githubCliFixtureArgv('pr-reviews', 'owner/repo', 4, true), [
      'api',
      'repos/owner/repo/pulls/4/reviews?per_page=1',
      '--paginate',
      '--slurp',
    ]);
  });
});
