import GitHubAccountKeyError from '../tools/github/account-key-error.ts';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { AgentSystemCliResult } from '../api/types.ts';
import GitHubAccountKeyService from '../tools/github/account-key-service.ts';
import type { AgentManifest } from '../manifest/types.ts';

const publicKey =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0 tanaabot@tanaab.dev';
const canonicalKey = publicKey.replace(' tanaabot@tanaab.dev', '');

function cliResult(stdout = ''): AgentSystemCliResult {
  return {
    exitCode: 0,
    stderr: '',
    stdout,
    timedOut: false,
    truncated: false,
  };
}

function manifestWithKeys(path: string): AgentManifest {
  return {
    schemaVersion: 1,
    agent: { id: 'tanaabot' },
    github: {
      sshKeys: [{ source: path, title: 'Scenario authentication key', type: 'path' }],
      sshSigningKeys: [{ source: publicKey, type: 'auto' }],
      token: 'GH_TOKEN_TANAABOT',
      username: 'tanaabot',
    },
  };
}

describe('tools/github/account-key-service', () => {
  let temporaryDirectory = '';

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'agent-system-github-keys-'));
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true });
  });

  it('should withhold upstream failure bodies while retaining safe authentication evidence', async () => {
    const service = new GitHubAccountKeyService({
      client: {
        connect: async () => ({
          execute: async () => ({
            ...cliResult('PRIVATE_RESPONSE op://vault/item/key'),
            exitCode: 1,
            stderr: 'PRIVATE_TOKEN Authorization: private (HTTP 401)',
          }),
        }),
      },
    });
    const manifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'data' },
      github: { username: 'data', token: 'TOKEN', sshKeys: [{ source: publicKey, type: 'auto' }] },
    };
    await assert.rejects(
      service.inspect({ manifest, workspaceDir: temporaryDirectory }),
      (error: unknown) => {
        assert.ok(error instanceof GitHubAccountKeyError);
        assert.equal(error.providerDiagnostic?.classification, 'authentication');
        assert.equal(error.providerDiagnostic?.httpStatus, 401);
        assert.ok(!/PRIVATE_|op:\/\/|Authorization/.test(error.message));
        return true;
      },
    );
  });

  it('should resolve path and inline sources before reporting remote drift', async () => {
    await writeFile(join(temporaryDirectory, 'auth.pub'), `${publicKey}\n`, 'utf8');
    const requests: string[][] = [];
    const service = new GitHubAccountKeyService({
      client: {
        async connect() {
          return {
            async execute(argv) {
              requests.push(argv);
              return cliResult(
                JSON.stringify(
                  argv.includes('/user/ssh_signing_keys') ? [[{ key: canonicalKey }]] : [[]],
                ),
              );
            },
          };
        },
      },
    });

    assert.deepEqual(
      await service.inspect({
        manifest: manifestWithKeys('auth.pub'),
        workspaceDir: temporaryDirectory,
      }),
      [
        {
          category: 'ssh',
          declared: 1,
          missingFingerprints: ['SHA256:6dlFAq8YbUfNEZep5XnC9SLWZDFEaN0AC/ZHApG4lsk'],
          status: 'missing',
        },
        {
          category: 'ssh-signing',
          declared: 1,
          missingFingerprints: [],
          status: 'ready',
        },
      ],
    );
    assert.deepEqual(requests, [
      ['api', '--paginate', '--slurp', '/user/keys'],
      ['api', '--paginate', '--slurp', '/user/ssh_signing_keys'],
    ]);
  });

  for (const status of [403, 429, undefined]) {
    it(`should retain ${status ?? 'unknown'} key creation evidence without replaying the write`, async () => {
      const requests: string[][] = [];
      const service = new GitHubAccountKeyService({
        client: {
          connect: async () => ({
            execute: async (argv) => {
              requests.push(argv);
              if (!argv.includes('POST')) return cliResult('[[]]');
              const body = '{"message":"PRIVATE_RESPONSE op://vault/item/key"}';
              return {
                ...cliResult(
                  status !== undefined && argv.includes('--include')
                    ? [
                        `HTTP/2 ${status}`,
                        'Retry-After: 120',
                        'X-RateLimit-Remaining: 4500',
                        'X-RateLimit-Resource: core',
                        'X-RateLimit-Reset: 2000000000',
                        'X-Private-Header: PRIVATE_HEADER',
                        '',
                        body,
                      ].join('\n')
                    : body,
                ),
                exitCode: 1,
                stderr: 'PRIVATE_STDERR',
              };
            },
          }),
        },
      });
      const manifest: AgentManifest = {
        schemaVersion: 1,
        agent: { id: 'tanaabot' },
        github: {
          username: 'tanaabot',
          token: 'TOKEN',
          sshKeys: [{ source: publicKey, type: 'auto' }],
        },
      };

      await assert.rejects(
        service.reconcile({ manifest, workspaceDir: temporaryDirectory }),
        (error: unknown) => {
          assert.ok(error instanceof GitHubAccountKeyError);
          assert.equal(error.code, 'github-account-key-create-failed');
          const evidence = error.providerDiagnostic;
          assert.equal(evidence?.classification, status === undefined ? 'unknown' : 'rate-limit');
          assert.equal(evidence?.httpStatus, status ?? null);
          assert.equal(evidence?.httpStatusSource, status === undefined ? undefined : 'structured');
          assert.equal(evidence?.retryAfterMs, status === undefined ? null : 120000);
          assert.equal(evidence?.resetAt, status === undefined ? null : 2000000000000);
          assert.equal(evidence?.quotaScope, status === undefined ? null : 'core');
          assert.doesNotMatch(`${error.message} ${JSON.stringify(evidence)}`, /PRIVATE_|op:\/\//u);
          assert.equal(error.cause, undefined);
          return true;
        },
      );
      assert.deepEqual(
        requests.map((argv) => (argv.includes('POST') ? 'create' : 'list')),
        ['list', 'create', 'list'],
      );
    });
  }

  it('should add only missing keys and verify both github collections', async () => {
    await writeFile(join(temporaryDirectory, 'auth.pub'), publicKey, 'utf8');
    const remote = new Map<string, string[]>([
      ['/user/keys', []],
      ['/user/ssh_signing_keys', []],
    ]);
    const requests: string[][] = [];
    const inputs: Array<{ key: string; title: string }> = [];
    const service = new GitHubAccountKeyService({
      client: {
        async connect() {
          return {
            async execute(argv, stdin) {
              requests.push(argv);
              const endpoint = argv.find((value) => value.startsWith('/user/')) ?? '';
              if (argv.includes('POST')) {
                assert.ok(stdin);
                const input = JSON.parse(stdin) as { key: string; title: string };
                inputs.push(input);
                remote.get(endpoint)?.push(input.key);
                return cliResult('HTTP/2 201 Created\nContent-Type: application/json\n\n{}');
              }
              return cliResult(
                JSON.stringify([remote.get(endpoint)?.map((key) => ({ key })) ?? []]),
              );
            },
          };
        },
      },
    });

    assert.deepEqual(
      await service.reconcile({
        manifest: manifestWithKeys('auth.pub'),
        workspaceDir: temporaryDirectory,
      }),
      [
        { category: 'ssh', created: 1, declared: 1 },
        { category: 'ssh-signing', created: 1, declared: 1 },
      ],
    );
    const creates = requests.filter((argv) => argv.includes('POST'));
    assert.equal(creates.length, 2);
    assert.deepEqual(creates, [
      ['api', '--include', '--method', 'POST', '/user/keys', '--input', '-'],
      ['api', '--include', '--method', 'POST', '/user/ssh_signing_keys', '--input', '-'],
    ]);
    assert.equal(inputs[0]?.title, 'Scenario authentication key');
    assert.equal(inputs[1]?.title, 'agent-system-tanaabot-ssh-signing-e9d94502af18');

    assert.deepEqual(
      await service.reconcile({
        manifest: manifestWithKeys('auth.pub'),
        workspaceDir: temporaryDirectory,
      }),
      [
        { category: 'ssh', created: 0, declared: 1 },
        { category: 'ssh-signing', created: 0, declared: 1 },
      ],
    );
  });

  it('should resolve every source before making a github request', async () => {
    let connected = false;
    const service = new GitHubAccountKeyService({
      client: {
        async connect() {
          connected = true;
          return { execute: async () => cliResult('[[]]') };
        },
      },
    });

    await assert.rejects(
      service.reconcile({
        manifest: manifestWithKeys('missing.pub'),
        workspaceDir: temporaryDirectory,
      }),
      /source 1 is invalid/u,
    );
    assert.equal(connected, false);
  });

  it('should accept concurrent convergence after a create conflict', async () => {
    await writeFile(join(temporaryDirectory, 'auth.pub'), publicKey, 'utf8');
    const remote: string[] = [];
    const service = new GitHubAccountKeyService({
      client: {
        async connect() {
          return {
            async execute(argv, stdin) {
              if (argv.includes('/user/ssh_signing_keys')) {
                return cliResult(JSON.stringify([[{ key: canonicalKey }]]));
              }
              if (argv.includes('POST')) {
                assert.ok(stdin);
                remote.push((JSON.parse(stdin) as { key: string }).key);
                return { ...cliResult(), exitCode: 1, stderr: 'key is already in use' };
              }
              return cliResult(JSON.stringify([remote.map((key) => ({ key }))]));
            },
          };
        },
      },
    });

    assert.deepEqual(
      await service.reconcile({
        manifest: manifestWithKeys('auth.pub'),
        workspaceDir: temporaryDirectory,
      }),
      [
        { category: 'ssh', created: 1, declared: 1 },
        { category: 'ssh-signing', created: 0, declared: 1 },
      ],
    );
  });
});
