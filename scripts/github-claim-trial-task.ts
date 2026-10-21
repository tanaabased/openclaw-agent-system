import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import type { ClaimClient, ClaimSource } from '../agent/assignment-claim.ts';
import type * as StoreModule from '../agent/assignment-claim-store.ts';
import type * as ClaimModule from '../agent/assignment-claim.ts';
import type * as ClaimBodyModule from '../channels/github/provider/assignment-claim.ts';
import type * as WorkClientModule from '../channels/github/provider/work-event-client.ts';
import type * as ClaimClientModule from '../channels/github/provider/assignment-claim-client.ts';
import type { AgentSystemCliResult } from '../api/types.ts';

// this hosted experiment uses the prepared package and never starts a native chat or gateway.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'the claim trial is github actions only');
assert.ok(process.env.AGENT_SYSTEM_PACKAGE);
assert.ok(process.env.GITHUB_WORKSPACE);
assert.ok(process.env.GH_TOKEN_TANAABOT);
assert.ok(process.env.GH_TOKEN_EMORI);
const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'github-claim-trial-'));
await execute('tar', ['-xzf', resolve(process.env.AGENT_SYSTEM_PACKAGE), '-C', root]);
const packageRoot = join(root, 'package');
await symlink(
  join(process.env.GITHUB_WORKSPACE, 'node_modules'),
  join(packageRoot, 'node_modules'),
  'dir',
);
const { default: Store } = (await import(
  pathToFileURL(join(packageRoot, 'agent/assignment-claim-store.ts')).href
)) as typeof StoreModule;
const { claimAssignment, acceptAssignmentClaim } = (await import(
  pathToFileURL(join(packageRoot, 'agent/assignment-claim.ts')).href
)) as typeof ClaimModule;
const { parseAssignmentClaim } = (await import(
  pathToFileURL(join(packageRoot, 'channels/github/provider/assignment-claim.ts')).href
)) as typeof ClaimBodyModule;
const { default: WorkClient } = (await import(
  pathToFileURL(join(packageRoot, 'channels/github/provider/work-event-client.ts')).href
)) as typeof WorkClientModule;
const { default: ProviderClaimClient } = (await import(
  pathToFileURL(join(packageRoot, 'channels/github/provider/assignment-claim-client.ts')).href
)) as typeof ClaimClientModule;

async function gh(token: string, argv: string[], input?: string): Promise<AgentSystemCliResult> {
  const task = execute('gh', argv, {
    env: { ...process.env, GH_TOKEN: token },
    timeout: 30_000,
    maxBuffer: 512 * 1024,
  });
  task.child.stdin?.end(input);
  try {
    const output = await task;
    return { ...output, exitCode: 0, timedOut: false, truncated: false };
  } catch (error) {
    const failure = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      timedOut: Boolean(failure.killed),
      truncated: false,
    };
  }
}
async function api(token: string, path: string, body?: object) {
  const result = await gh(
    token,
    ['api', path, ...(body ? ['--method', 'POST', '--input', '-'] : [])],
    body && JSON.stringify(body),
  );
  assert.equal(result.exitCode, 0, `github fixture operation failed: ${path}`);
  return JSON.parse(result.stdout);
}
const receiverToken = process.env.GH_TOKEN_TANAABOT;
const actorToken = process.env.GH_TOKEN_EMORI;
const receiver = await api(receiverToken, 'user');
const actor = await api(actorToken, 'user');
assert.equal(receiver.login, 'tanaabot');
assert.equal(actor.login, 'emoriwan');
const repository = 'tanaabased/big-test-bucket';
const client = new WorkClient({
  identity: { login: receiver.login, nodeId: receiver.node_id },
  execute: (argv, input) => gh(receiverToken, argv, input),
});
const provider = new ProviderClaimClient(client);
let issueNumber: number | undefined;
let source: ClaimSource | undefined;
let cleanupVerified = false;
let retainedClaimId: number | undefined;
const evidence: Record<string, unknown> = {
  packageRoot,
  runId: process.env.GITHUB_RUN_ID,
  boundary:
    'real github comments and durable stores; native preparation is a counted test callback',
};
try {
  const issue = await api(actorToken, `repos/${repository}/issues`, {
    title: `Agent System #402 claim trial ${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    body: 'Disposable two-instance claim trial. No implementation or native issue chat is requested.',
  });
  issueNumber = issue.number;
  assert.ok(issueNumber);
  evidence.issue = issue.html_url;
  await writeFile(join(root, 'fixture.json'), JSON.stringify({ issueNumber, repository }));
  await api(actorToken, `repos/${repository}/issues/${issueNumber}/assignees`, {
    assignees: ['tanaabot'],
  });
  const repo = await client.getRepository('tanaabased', 'big-test-bucket');
  let event;
  for (let attempt = 0; attempt < 10; attempt++) {
    const history = await client.listAssignmentEvents('tanaabased', 'big-test-bucket', issueNumber);
    assert.equal(history.truncated, false);
    event = history.events.find(
      (entry) => entry.event === 'assigned' && entry.assignee.nodeId === receiver.node_id,
    );
    if (event) break;
    await setTimeout(1000);
  }
  assert.ok(event, 'assignment event must become observable within the bounded fixture setup');
  source = {
    owner: 'tanaabased',
    repository: 'big-test-bucket',
    repositoryNodeId: repo.nodeId,
    issueNodeId: issue.node_id,
    number: issueNumber,
    receivingNodeId: receiver.node_id,
    assignmentEventId: event.nodeId,
    assignerNodeId: actor.node_id,
  };
  const stores = [new Store(join(root, 'a')), new Store(join(root, 'b'))];
  const identities = await Promise.all(stores.map((store) => store.identity()));
  assert.notEqual(identities[0]!.instanceId, identities[1]!.instanceId);
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolveBarrier) => {
    release = resolveBarrier;
  });
  const barrierTimeout = AbortSignal.timeout(30_000);
  const ports = stores.map((_, index): ClaimClient => ({
    verify: (value) => provider.verify(value),
    async list(value) {
      const snapshot = await provider.list(value);
      assert.equal(snapshot.length, 0);
      if (++arrivals === 2) release();
      await Promise.race([
        barrier,
        new Promise<never>((_, reject) => {
          if (barrierTimeout.aborted) reject(new Error('trial-contention-timeout'));
          else
            barrierTimeout.addEventListener(
              'abort',
              () => reject(new Error('trial-contention-timeout')),
              { once: true },
            );
        }),
      ]);
      return snapshot;
    },
    async create(value, body) {
      const receipt = await provider.create(value, body);
      if (index === 1) throw new Error('trial-lost-write-response');
      return receipt;
    },
    update: (...args) => provider.update(...args),
    remove: (...args) => provider.remove(...args),
  }));
  const first = await Promise.allSettled(
    stores.map((store, index) =>
      claimAssignment({
        store,
        client: ports[index]!,
        source: source!,
        passId: 'trial-pass-1',
        hasCapacity: true,
      }),
    ),
  );
  assert.equal(first[0]!.status, 'fulfilled');
  assert.equal(first[1]!.status, 'rejected');
  const visible = await provider.list(source);
  assert.equal(visible.length, 2);
  evidence.claimIds = visible.map((comment) => comment.databaseId);
  evidence.assignmentEventId = source.assignmentEventId;
  assert.equal(
    (
      await claimAssignment({
        store: stores[0]!,
        client: provider,
        source,
        passId: 'trial-pass-1',
        hasCapacity: true,
      })
    ).status,
    'pending',
  );
  stores[1] = new Store(join(root, 'b'));
  const second = await Promise.all(
    stores.map((store) =>
      claimAssignment({
        store,
        client: provider,
        source: source!,
        passId: 'trial-pass-2',
        hasCapacity: true,
      }),
    ),
  );
  assert.equal(second.filter((result) => result.status === 'owned').length, 1);
  assert.equal(second.filter((result) => result.status === 'other-owner').length, 1);
  const winner = second.findIndex((result) => result.status === 'owned');
  assert.equal(second[winner]!.winnerId, Math.min(...visible.map((comment) => comment.databaseId)));
  const surviving = await provider.list(source);
  assert.equal(surviving.length, 1);
  const metadata = parseAssignmentClaim(surviving[0]!);
  assert.equal(metadata?.instanceId, identities[winner]!.instanceId);
  const prepared: string[] = [];
  for (const [index, result] of second.entries())
    if (result.status === 'owned') prepared.push(identities[index]!.instanceId);
  assert.equal(prepared.length, 1);
  await stores[winner]!.rename('Trial_Winner');
  await acceptAssignmentClaim({
    store: stores[winner]!,
    client: provider,
    source,
    nativeReceipt: 'trial-only-verified-preparation-callback',
  });
  const accepted = await provider.list(source);
  assert.match(accepted[0]!.body, /^Assignment accepted on `trial-winner`/u);
  assert.equal(accepted[0]!.databaseId, surviving[0]!.databaseId);
  assert.deepEqual(parseAssignmentClaim(accepted[0]!), metadata);
  const copy = new Store(join(root, 'copy'));
  await copy.identity();
  await copyFile(
    join(root, winner === 0 ? 'a' : 'b', 'assignment-claims.json'),
    join(root, 'copy', 'assignment-claims.json'),
  );
  const rotated = await copy.rotate(identities[winner]!.instanceId);
  assert.notEqual(rotated.instanceId, identities[winner]!.instanceId);
  assert.equal(
    (
      await claimAssignment({
        store: copy,
        client: provider,
        source,
        passId: 'trial-pass-3',
        hasCapacity: true,
      })
    ).code,
    'claim-instance-rotated',
  );
  assert.equal(
    (
      await claimAssignment({
        store: new Store(join(root, winner === 0 ? 'a' : 'b')),
        client: provider,
        source,
        passId: 'trial-pass-3',
        hasCapacity: true,
      })
    ).status,
    'owned',
  );
  evidence.results = {
    firstPass: first.map((result) => result.status),
    secondPass: second,
    nativePreparationCallbacks: prepared.length,
    retainedCommentId: accepted[0]!.databaseId,
    renameVerified: true,
    restartVerified: true,
    lostResponseReconciled: true,
    rotationDetached: true,
  };
  retainedClaimId = accepted[0]!.databaseId;
  evidence.retainedClaim = `${issue.html_url}#issuecomment-${retainedClaimId}`;
} finally {
  const cleanupErrors: unknown[] = [];
  try {
    if (issueNumber) {
      try {
        if (source) {
          const owned = await provider.list(source);
          for (const comment of owned) {
            const metadata = parseAssignmentClaim(comment);
            if (
              metadata &&
              comment.author?.nodeId === receiver.node_id &&
              metadata.assignmentEventId === source.assignmentEventId &&
              comment.databaseId !== retainedClaimId
            ) {
              try {
                await provider.remove(source, comment.databaseId, comment.body);
              } catch (error) {
                cleanupErrors.push(error);
              }
            }
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      // closing the fixture must still be attempted when comment cleanup fails.
      const close = await gh(
        actorToken,
        ['api', '--method', 'PATCH', `repos/${repository}/issues/${issueNumber}`, '--input', '-'],
        JSON.stringify({ state: 'closed' }),
      );
      assert.equal(close.exitCode, 0);
      const closed = await api(actorToken, `repos/${repository}/issues/${issueNumber}`);
      assert.equal(closed.state, 'closed');
      const remaining = await api(actorToken, `repos/${repository}/issues/${issueNumber}/comments`);
      assert.deepEqual(
        remaining.map((comment: { id: number }) => comment.id),
        retainedClaimId ? [retainedClaimId] : [],
      );
      cleanupVerified = cleanupErrors.length === 0;
    }
  } catch (error) {
    cleanupErrors.push(error);
  } finally {
    evidence.cleanupVerified = cleanupVerified;
    evidence.cleanupErrors = cleanupErrors.map((error) =>
      error instanceof Error ? error.message : String(error),
    );
    await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    if (cleanupErrors.length) process.exitCode = 1;
  }
}
assert.equal(cleanupVerified, true);
