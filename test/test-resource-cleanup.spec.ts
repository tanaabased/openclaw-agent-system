import assert from 'node:assert/strict';

import { strToU8, zipSync, type Zippable } from 'fflate';
import createTestIssue from '../scripts/create-test-issue.ts';

import cleanupTestResources, {
  authorizeTestResourceCleanup,
  type TestResourceRequest,
  type TestResourceRun,
} from '../scripts/test-resource-cleanup.ts';
import {
  issueMarker,
  mergeReceiptCheckpoints,
  parseTestResourceReceipt,
  readReceiptArchive,
  testBucket,
  testBucketId,
  type TestResource,
  type TestResourceReceipt,
} from '../scripts/test-resource-receipts.ts';
import parseSshPublicKey from '../utils/parse-ssh-public-key.ts';

const startedAt = '2026-10-25T10:00:00Z';
const createdAt = '2026-10-25T10:01:00Z';
const completedAt = '2026-10-25T10:10:00Z';
const tanaabot = { login: 'tanaabot' as const, nodeId: 'BOT' };
const emori = { login: 'emoriwan' as const, nodeId: 'EMORI' };
const source: TestResourceReceipt['source'] = {
  repository: 'tanaabased/openclaw-agent-system',
  repositoryId: 77,
  runId: 100,
  attempt: 2,
  workflow: '.github/workflows/pr-examples-notifications.yml',
  jobName: 'openclaw-notifications-work (ubuntu-24.04)',
  scenario: 'openclaw-notifications-work',
  os: 'ubuntu-24.04',
  nonce: '11111111-1111-4111-8111-111111111111',
};
const run: TestResourceRun = {
  ...source,
  status: 'completed',
  startedAt,
  completedAt,
  jobs: [
    {
      id: 9,
      name: source.jobName,
      status: 'completed',
      startedAt,
      completedAt,
      labels: ['ubuntu-24.04', 'Linux', 'X64'],
    },
  ],
};
const publicKey = parseSshPublicKey(
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPRZeOEqvPxiT3iygvnST8ZByU8hK96JoQf5MLybe4v0',
);
const key: Extract<TestResource, { kind: 'authentication-key' | 'signing-key' }> = {
  kind: 'authentication-key',
  receiptId: 'key',
  account: tanaabot,
  publicKey: publicKey.key,
  fingerprint: publicKey.fingerprint,
  title: 'agent-system-work-100-2',
  id: 7,
};
const issueId = '22222222-2222-4222-8222-222222222222';
const issue: Extract<TestResource, { kind: 'issue' }> = {
  kind: 'issue',
  receiptId: issueId,
  repository: testBucket,
  account: emori,
  marker: issueMarker(source, issueId),
  number: 8,
  nodeId: 'ISSUE',
};
const pull: Extract<TestResource, { kind: 'pull-request' }> = {
  kind: 'pull-request',
  receiptId: 'pull',
  repository: testBucket,
  account: tanaabot,
  number: 10,
  nodeId: 'PR',
  issueNodeId: 'ISSUE',
  branch: 'fixture',
  headSha: 'a'.repeat(40),
};
const receipt = (resources: TestResource[] = []): TestResourceReceipt => ({
  version: 1,
  source: structuredClone(source),
  sequence: 0,
  finished: true,
  problems: [],
  resources: structuredClone(resources),
});

function provider() {
  const calls: Array<{
    account: string;
    method: string;
    route: string;
    body?: Record<string, unknown>;
  }> = [];
  const state = {
    keys: [{ id: 7, key: publicKey.key, title: key.title, created_at: createdAt }],
    issue: {
      number: 8,
      node_id: 'ISSUE',
      body: `fixture\n${issue.marker}`,
      user: { login: emori.login, node_id: emori.nodeId },
      created_at: createdAt,
      state: 'open',
    },
    pull: {
      number: 10,
      node_id: 'PR',
      state: 'open',
      user: { login: tanaabot.login, node_id: tanaabot.nodeId },
      created_at: createdAt,
      head: { ref: 'fixture', sha: pull.headSha, repo: { id: testBucketId } },
    },
    pulls: false,
    issueAbsent: false,
    branch: pull.headSha,
  };
  const request: TestResourceRequest = async (account, method, route, body) => {
    calls.push({ account, method, route, body });
    const ok = (value: unknown, status = 200) => ({ status, value: structuredClone(value) });
    if (route === 'user')
      return ok({ login: account, node_id: account === 'tanaabot' ? 'BOT' : 'EMORI' });
    if (route === `repos/${testBucket}`)
      return ok({ id: testBucketId, full_name: testBucket, permissions: { admin: true } });
    if (route.startsWith('user/keys?') || route.startsWith('user/ssh_signing_keys?'))
      return ok(state.keys);
    if (route === 'user/keys/7' || route === 'user/ssh_signing_keys/7') {
      if (method === 'DELETE') {
        state.keys = [];
        return ok(null, 204);
      }
      return state.keys[0] ? ok(state.keys[0]) : ok({}, 404);
    }
    if (route.startsWith(`repos/${testBucket}/issues?`))
      return ok(state.issueAbsent ? [] : [state.issue]);
    if (route === `repos/${testBucket}/issues/8`) {
      if (method === 'PATCH') state.issue.state = 'closed';
      return state.issueAbsent ? ok({}, 410) : ok(state.issue);
    }
    if (route.includes('/comments?')) return ok([]);
    if (route.startsWith(`repos/${testBucket}/pulls?`)) return ok(state.pulls ? [state.pull] : []);
    if (route === `repos/${testBucket}/pulls/10`) {
      if (method === 'PATCH') state.pull.state = 'closed';
      return ok(state.pull);
    }
    if (route === `repos/${testBucket}/git/refs/heads/fixture`) {
      if (method === 'DELETE') {
        state.branch = '';
        return ok(null, 204);
      }
      return state.branch ? ok({ object: { sha: state.branch } }) : ok({}, 404);
    }
    if (route === 'graphql') {
      const query = String(body?.query);
      if (query.includes('closingIssuesReferences'))
        return ok({
          data: {
            node: {
              closingIssuesReferences: {
                nodes: [{ id: 'ISSUE' }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        });
      if (query.startsWith('mutation')) {
        state.issueAbsent = true;
        return ok({ data: { deleteIssue: { clientMutationId: issueId } } });
      }
      return ok({ data: { node: state.issueAbsent ? null : { id: 'ISSUE' } } });
    }
    throw new Error(`unexpected request ${method} ${route}`);
  };
  return { calls, state, request };
}

describe('test resource receipts', () => {
  it('publishes creation intent before the write and ids before returning to scenario assertions', async () => {
    const checkpoints: TestResourceReceipt[] = [];
    const value = await createTestIssue({
      receipt: receipt(),
      title: 'fixture',
      body: 'body',
      account: emori,
      checkpoint: async (value) => {
        checkpoints.push(structuredClone(value));
      },
      create: async (body) => {
        assert.equal(checkpoints.length, 1);
        assert.equal(checkpoints[0]!.resources[0]!.kind, 'issue');
        assert.equal('number' in checkpoints[0]!.resources[0]!, false);
        assert.ok(body.body.includes('<!-- agent-system-test:77:100:2:'));
        return { ...provider().state.issue, body: body.body };
      },
    });
    assert.equal(value.node_id, 'ISSUE');
    assert.equal(checkpoints.length, 2);
    assert.equal('number' in checkpoints[1]!.resources[0]!, true);
  });

  it('does not create without an acknowledged intent or replay an uncertain creation', async () => {
    let writes = 0;
    const retained: TestResourceReceipt[] = [];
    for (const intentFails of [true, false]) {
      await assert.rejects(
        createTestIssue({
          receipt: receipt(),
          title: 'fixture',
          body: 'body',
          account: emori,
          checkpoint: async (value) => {
            if (intentFails) throw new Error('upload unavailable');
            retained.push(structuredClone(value));
          },
          create: async () => {
            writes++;
            throw new Error('response lost');
          },
        }),
      );
    }
    assert.equal(writes, 1);
    assert.equal(retained.length, 1);
    assert.equal(retained[0]!.resources[0]!.kind, 'issue');
  });

  it('accepts immutable checkpoints and rejects changed ownership or disappearing resources', () => {
    const first = receipt([key]);
    first.finished = false;
    const next = structuredClone(first);
    next.sequence++;
    next.finished = true;
    next.resources.push(issue);
    assert.deepEqual(mergeReceiptCheckpoints([next, first]), [next]);
    const changed = structuredClone(next);
    changed.resources[0]!.account.nodeId = 'FOREIGN';
    assert.throws(() => mergeReceiptCheckpoints([first, changed]), /checkpoint-conflict/u);
    next.resources = [];
    assert.throws(() => mergeReceiptCheckpoints([first, next]), /checkpoint-conflict/u);
    assert.throws(
      () => mergeReceiptCheckpoints([{ ...first, sequence: 1 }]),
      /initial-checkpoint-missing/u,
    );
  });

  it('rejects secret fields, conflicting checkpoints and invalid issue markers', () => {
    assert.throws(
      () => parseTestResourceReceipt({ ...receipt(), token: 'must-not-upload' }),
      /receipt-invalid/u,
    );
    const first = receipt([issue]);
    const changed = structuredClone(first);
    changed.finished = false;
    assert.throws(() => mergeReceiptCheckpoints([first, changed]), /checkpoint-conflict/u);
    assert.throws(
      () => parseTestResourceReceipt(receipt([{ ...issue, marker: '<!-- another run -->' }])),
      /issue-receipt-invalid/u,
    );
  });

  it('reads bounded data without accepting archive paths, extra files or decompression bombs', () => {
    const bytes = strToU8(JSON.stringify(receipt([key, issue])));
    assert.deepEqual(readReceiptArchive(zipSync({ 'receipt.json': bytes })), receipt([key, issue]));
    const archives: Zippable[] = [
      { '../receipt.json': bytes },
      { 'receipt.json': bytes, 'extra.json': bytes },
      { 'receipt.json': new Uint8Array(130 * 1024) },
    ];
    for (const files of archives) {
      assert.throws(() => readReceiptArchive(zipSync(files)), /archive-invalid/u);
    }
    assert.throws(() => readReceiptArchive(new Uint8Array(130 * 1024)), /archive-too-large/u);
  });
});

describe('completed test resource cleanup', () => {
  it('preserves a native pr whose head changed after the source job ended', async () => {
    const api = provider();
    api.state.pull.head.sha = 'b'.repeat(40);
    const report = await cleanupTestResources({
      run,
      receipts: [receipt([key, issue, pull])],
      request: api.request,
      captureEvidence: async () => {},
    });
    assert.equal(report.status, 'partial');
    assert.equal(api.state.keys.length, 0);
    assert.equal(api.state.pull.state, 'open');
    assert.equal(api.state.issueAbsent, false);
    assert.equal(
      api.calls.some(({ method }) => method === 'PATCH'),
      false,
    );
  });
  it('reconciles an already completed cleanup without repeating writes after issue deletion', async () => {
    const api = provider();
    const input = {
      run,
      receipts: [receipt([key, issue, pull])],
      request: api.request,
      captureEvidence: async () => {},
    };
    assert.equal((await cleanupTestResources(input)).status, 'complete');
    api.calls.length = 0;
    const retried = await cleanupTestResources(input);
    assert.equal(retried.status, 'complete');
    assert.equal(
      api.calls.some(
        ({ method, body }) =>
          method === 'DELETE' || method === 'PATCH' || String(body?.query).startsWith('mutation'),
      ),
      false,
    );
  });
  it('preserves concurrent-run keys and prs that are not linked to a verified owned issue', async () => {
    const api = provider();
    const concurrentKey = { ...key, title: 'agent-system-work-1100-2' };
    api.state.keys[0]!.title = concurrentKey.title;
    api.state.issue.body = 'another run';
    const report = await cleanupTestResources({
      run,
      receipts: [receipt([concurrentKey, issue, pull])],
      request: api.request,
      captureEvidence: async () => {},
    });
    assert.equal(report.status, 'partial');
    assert.equal(
      api.calls.some(({ method }) => method === 'DELETE' || method === 'PATCH'),
      false,
    );
    const other = provider();
    await cleanupTestResources({
      run,
      receipts: [receipt([issue, pull])],
      request: async (...args) =>
        String(args[3]?.query).includes('closingIssuesReferences')
          ? {
              status: 200,
              value: {
                data: {
                  node: {
                    closingIssuesReferences: {
                      nodes: [{ id: 'FOREIGN' }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
              },
            }
          : other.request(...args),
      captureEvidence: async () => {},
    });
    assert.equal(other.state.pull.state, 'open');
    assert.equal(other.state.issueAbsent, false);
  });
  it('closes issues with write access and reports that permanent deletion requires admin', async () => {
    const api = provider();
    const report = await cleanupTestResources({
      run,
      receipts: [receipt([issue])],
      request: async (...args) =>
        args[2] === `repos/${testBucket}`
          ? {
              status: 200,
              value: {
                id: testBucketId,
                full_name: testBucket,
                permissions: { admin: false, push: true },
              },
            }
          : api.request(...args),
      captureEvidence: async () => {},
    });
    assert.equal(report.status, 'complete');
    assert.equal(api.state.issue.state, 'closed');
    assert.equal(api.state.issueAbsent, false);
    assert.equal(report.outcomes[0]!.code, 'test-resource-issue-delete-admin-required');
    assert.equal(
      api.calls.some(({ body }) => String(body?.query).startsWith('mutation')),
      false,
    );
  });
  it('rejects active runs, other attempts, foreign jobs and self-hosted runners before provider access', async () => {
    const invalid = [
      { ...run, status: 'in_progress' },
      { ...run, attempt: 1 },
      { ...run, repositoryId: 99 },
      { ...run, workflow: '.github/workflows/release.yml' },
      { ...run, jobs: [{ ...run.jobs[0]!, name: 'other' }] },
      { ...run, jobs: [{ ...run.jobs[0]!, labels: ['self-hosted', 'ubuntu-24.04'] }] },
    ];
    for (const candidate of invalid) {
      let called = false;
      await assert.rejects(
        cleanupTestResources({
          run: candidate,
          receipts: [receipt([key])],
          request: async () => {
            called = true;
            throw new Error('no');
          },
          captureEvidence: async () => {},
        }),
        /test-resource-/u,
      );
      assert.equal(called, false);
    }
  });

  it('captures issue and pr evidence before deletion and removes only a frozen branch head', async () => {
    const api = provider();
    let captured = false;
    const report = await cleanupTestResources({
      run,
      receipts: [receipt([key, issue, pull])],
      request: async (...args) => {
        if (args[1] === 'POST' && String(args[3]?.query).startsWith('mutation'))
          assert.equal(captured, true);
        return api.request(...args);
      },
      captureEvidence: async (snapshots) => {
        assert.equal(snapshots.length, 2);
        captured = true;
      },
    });
    assert.equal(report.status, 'complete');
    assert.deepEqual(
      report.outcomes.map(({ effect, status }) => [effect, status]),
      [
        ['authentication-key', 'deleted'],
        ['pull-request', 'closed'],
        ['branch', 'deleted'],
        ['issue', 'deleted'],
      ],
    );
    assert.equal(api.state.issueAbsent, true);
    assert.equal(api.state.branch, '');
  });

  it('preserves unrelated keys and issues while still attempting independent signing cleanup', async () => {
    const api = provider();
    api.state.keys[0]!.title = 'foreign key';
    api.state.issue.body = 'foreign issue';
    const signing = { ...key, kind: 'signing-key' as const, receiptId: 'signing' };
    const report = await cleanupTestResources({
      run,
      receipts: [receipt([key, signing, issue])],
      request: api.request,
      captureEvidence: async () => {
        assert.fail('no owned issue');
      },
    });
    assert.equal(report.status, 'partial');
    assert.equal(report.outcomes.filter(({ status }) => status === 'preserved').length, 3);
    assert.ok(api.calls.some(({ route }) => route === 'user/ssh_signing_keys/7'));
    assert.equal(api.calls.filter(({ method }) => method === 'DELETE').length, 0);
  });

  it('continues issue cleanup when a key category fails and preserves issues if evidence upload fails', async () => {
    for (const evidenceFails of [false, true]) {
      const api = provider();
      const report = await cleanupTestResources({
        run,
        receipts: [receipt([key, issue])],
        request: async (...args) =>
          args[2].startsWith('user/keys') ? { status: 403, value: {} } : api.request(...args),
        captureEvidence: async () => {
          if (evidenceFails) throw new Error('upload failed');
        },
      });
      assert.equal(report.status, 'partial');
      assert.equal(api.state.issueAbsent, !evidenceFails);
      assert.ok(
        report.outcomes.some(
          ({ effect, status }) => effect === 'authentication-key' && status === 'failed',
        ),
      );
    }
  });

  it('verifies fresh account and repository access before treating missing resources as absent', async () => {
    const api = provider();
    api.state.keys = [];
    api.state.issueAbsent = true;
    const report = await cleanupTestResources({
      run,
      receipts: [receipt([key, issue])],
      request: api.request,
      captureEvidence: async () => {},
    });
    assert.equal(report.status, 'complete');
    assert.deepEqual(
      report.outcomes.map(({ status }) => status),
      ['absent', 'absent'],
    );
    for (const route of ['user', `repos/${testBucket}`]) {
      const blocked = await cleanupTestResources({
        run,
        receipts: [receipt([issue])],
        request: async (...args) =>
          args[2] === route ? { status: 403, value: {} } : api.request(...args),
        captureEvidence: async () => {},
      });
      assert.equal(blocked.outcomes[0]!.status, 'failed');
    }
  });

  it('reconciles durable issue and key intents after cancellation without replaying creation', async () => {
    const api = provider();
    const intentKey = { ...key };
    delete intentKey.id;
    const intentIssue = { ...issue };
    delete intentIssue.number;
    delete intentIssue.nodeId;
    const interrupted = receipt([intentKey, intentIssue]);
    interrupted.finished = false;
    const report = await cleanupTestResources({
      run,
      receipts: [interrupted],
      request: api.request,
      captureEvidence: async () => {},
    });
    assert.ok(
      report.outcomes.some(({ effect, status }) => effect === 'issue' && status === 'deleted'),
    );
    assert.ok(
      report.outcomes.some(
        ({ effect, status }) => effect === 'authentication-key' && status === 'deleted',
      ),
    );
    assert.ok(
      report.outcomes.some(({ code }) => code === 'test-resource-final-checkpoint-missing'),
    );
    assert.equal(
      api.calls.some(({ method, route }) => method === 'POST' && route.includes('/issues')),
      false,
    );
  });

  it('recovers linked native prs but preserves branches without a captured head receipt', async () => {
    const api = provider();
    api.state.pulls = true;
    const report = await cleanupTestResources({
      run,
      receipts: [receipt([issue])],
      request: api.request,
      captureEvidence: async () => {},
    });
    assert.equal(api.state.pull.state, 'closed');
    assert.equal(api.state.issueAbsent, true);
    assert.equal(api.state.branch, pull.headSha);
    assert.ok(report.outcomes.some(({ code }) => code === 'test-resource-branch-receipt-missing'));
  });

  it('preserves changed branch heads and never deletes an issue whose pr cleanup was denied', async () => {
    const api = provider();
    api.state.branch = 'b'.repeat(40);
    const report = await cleanupTestResources({
      run,
      receipts: [receipt([issue, pull])],
      request: api.request,
      captureEvidence: async () => {},
    });
    assert.ok(report.outcomes.some(({ code }) => code === 'test-resource-branch-head-changed'));
    assert.equal(api.state.branch, 'b'.repeat(40));
    const denied = provider();
    await cleanupTestResources({
      run,
      receipts: [receipt([key, issue, pull])],
      request: async (...args) =>
        args[1] === 'PATCH' ? { status: 403, value: {} } : denied.request(...args),
      captureEvidence: async () => {},
    });
    assert.equal(denied.state.issueAbsent, false);
    assert.equal(denied.state.keys.length, 0);
  });

  it('reconciles a lost delete acknowledgement but never overrides an authoritative denial', async () => {
    for (const denial of [false, true]) {
      const api = provider();
      const report = await cleanupTestResources({
        run,
        receipts: [receipt([issue])],
        request: async (...args) => {
          if (args[1] === 'POST' && String(args[3]?.query).startsWith('mutation')) {
            if (denial) return { status: 200, value: { errors: [{ type: 'FORBIDDEN' }] } };
            await api.request(...args);
            return { status: 502, value: {} };
          }
          return api.request(...args);
        },
        captureEvidence: async () => {},
      });
      assert.equal(report.outcomes.at(-1)!.status, denial ? 'failed' : 'absent');
    }
  });

  it('reports empty or incomplete source jobs instead of claiming a clean inventory', async () => {
    assert.deepEqual(authorizeTestResourceCleanup(run, [receipt()]), [receipt()]);
    const report = await cleanupTestResources({
      run,
      receipts: [],
      request: async () => {
        assert.fail('no resources');
      },
      captureEvidence: async () => {},
    });
    assert.equal(report.status, 'partial');
    assert.equal(report.outcomes[0]!.code, 'test-resource-job-receipts-missing');
  });
});
