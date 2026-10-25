import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';

import createTestIssue from './create-test-issue.ts';
import parseAgentManifest from '../manifest/parse.ts';
import {
  githubAccountKeyCategories,
  isInlineGitHubAccountKeySource,
} from '../tools/github/account-key-declarations.ts';
import parseSshPublicKey from '../utils/parse-ssh-public-key.ts';
import cleanupTestResources, {
  authorizeTestResourceCleanup,
  testResourceObject as object,
  type TestResourceRequest,
  type TestResourceRun,
} from './test-resource-cleanup.ts';
import {
  parseTestResourceReceipt,
  readReceiptArchive,
  receiptArtifactName,
  receiptLimit,
  testBucket,
  type TestResourceAccount,
  type TestResourceReceipt,
} from './test-resource-receipts.ts';

const artifacts = new DefaultArtifactClient();
const required = (name: string) => {
  const value = process.env[name];
  assert.ok(value, `test-resource-environment-missing:${name}`);
  return value;
};
const journalPath = () => join(required('RUNNER_TEMP'), 'test-resources', 'receipt.json');
const load = async () =>
  parseTestResourceReceipt(JSON.parse(await readFile(journalPath(), 'utf8')));
async function save(receipt: TestResourceReceipt) {
  parseTestResourceReceipt(receipt);
  const path = journalPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(receipt), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}
async function checkpoint(receipt: TestResourceReceipt) {
  // At most ten immutable uploads per job: initial, keys, three issue pairs, final.
  assert.ok(receipt.sequence < 10, 'test-resource-checkpoint-limit');
  await save(receipt);
  const uploaded = await artifacts.uploadArtifact(
    receiptArtifactName(receipt),
    [journalPath()],
    dirname(journalPath()),
    { retentionDays: 7, compressionLevel: 0 },
  );
  assert.ok(uploaded.id, 'test-resource-checkpoint-unacknowledged');
}
const token = (account: Parameters<TestResourceRequest>[0]) =>
  required(
    account === 'actions'
      ? 'GITHUB_TOKEN'
      : account === 'tanaabot'
        ? 'GH_TOKEN_TANAABOT'
        : 'GH_TOKEN_EMORI',
  );
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  assert.ok(
    response.body && Number(response.headers.get('content-length') ?? 0) <= limit,
    'test-resource-response-too-large',
  );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      assert.ok(size <= limit, 'test-resource-response-too-large');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
export const providerRequest: TestResourceRequest = async (account, method, route, body) => {
  assert.ok(
    !route.startsWith('/') && !route.includes('..') && !route.includes('://'),
    'test-resource-route-invalid',
  );
  const response = await fetch(`https://api.github.com/${route}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      authorization: `Bearer ${token(account)}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const bytes = await boundedBytes(response, 2 * 1024 * 1024);
  return {
    status: response.status,
    value: bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : null,
  };
};
async function read(account: Parameters<TestResourceRequest>[0], route: string) {
  const response = await providerRequest(account, 'GET', route);
  assert.equal(response.status, 200, 'test-resource-read-failed');
  return response.value;
}
async function identity(login: TestResourceAccount['login']): Promise<TestResourceAccount> {
  const user = object(await read(login, 'user'));
  assert.equal(user.login, login, 'test-resource-account-mismatch');
  assert.equal(typeof user.node_id, 'string', 'test-resource-account-invalid');
  return { login, nodeId: String(user.node_id) };
}
async function prepare(scenario: string, os: string) {
  // The runner supplies these only to Node actions. Export the supported artifact
  // transport to subsequent inline fixture checkpoints; never copy the environment.
  for (const name of ['ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RUNTIME_URL', 'ACTIONS_RESULTS_URL']) {
    const value = required(name);
    core.setSecret(value);
    core.exportVariable(name, value);
  }
  const repository = required('GITHUB_REPOSITORY');
  const workflow = required('GITHUB_WORKFLOW_REF')
    .split('@')[0]!
    .slice(repository.length + 1);
  const receipt: TestResourceReceipt = {
    version: 1,
    sequence: 0,
    finished: false,
    problems: [],
    resources: [],
    source: {
      repository,
      repositoryId: Number(required('GITHUB_REPOSITORY_ID')),
      runId: Number(required('GITHUB_RUN_ID')),
      attempt: Number(required('GITHUB_RUN_ATTEMPT')),
      workflow,
      jobName: `${scenario} (${os})`,
      scenario,
      os,
      nonce: randomUUID(),
    },
  };
  await checkpoint(receipt);
}
async function keys(manifestPath: string) {
  const receipt = await load();
  const parsed = parseAgentManifest(await readFile(manifestPath, 'utf8'));
  assert.equal(parsed.status, 'valid', 'test-resource-manifest-invalid');
  if (parsed.status !== 'valid' || !parsed.manifest.github) return;
  const config = parsed.manifest.github;
  assert.ok(
    config.username === 'tanaabot' || config.username === 'emoriwan',
    'test-resource-account-not-supported',
  );
  const account = await identity(config.username);
  for (const category of githubAccountKeyCategories(config)) {
    for (const declaration of category.sources) {
      const publicKey = parseSshPublicKey(
        isInlineGitHubAccountKeySource(declaration)
          ? declaration.source
          : await readFile(resolve(dirname(manifestPath), declaration.source), 'utf8'),
      );
      assert.ok(
        declaration.title &&
          new RegExp(`(?:^|-)${receipt.source.runId}-${receipt.source.attempt}(?:-|$)`, 'u').test(
            declaration.title,
          ),
        'test-resource-key-title-required',
      );
      receipt.resources.push({
        receiptId: `${category.category}:${publicKey.fingerprint}`,
        kind: category.category === 'ssh' ? 'authentication-key' : 'signing-key',
        account,
        publicKey: publicKey.key,
        fingerprint: publicKey.fingerprint,
        title: declaration.title!,
      });
    }
  }
  receipt.sequence++;
  await checkpoint(receipt);
}
async function createIssue(title: string, body: string, output: string) {
  assert.ok(output, 'test-resource-output-required');
  const issue = await createTestIssue({
    receipt: await load(),
    title,
    body,
    account: await identity('emoriwan'),
    checkpoint,
    create: async (payload) => {
      const result = spawnSync(
        'openclaw',
        [
          'agent-system',
          'tool',
          'gh',
          '--',
          'api',
          '--method',
          'POST',
          `repos/${testBucket}/issues`,
          '--input',
          '-',
        ],
        {
          input: JSON.stringify(payload),
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.ok(result.status === 0 && !result.error, 'test-resource-issue-create-unresolved');
      return JSON.parse(result.stdout);
    },
  });
  await writeFile(output, `${JSON.stringify(issue)}\n`, { mode: 0o600 });
}
async function finish() {
  const receipt = await load();
  for (const resource of receipt.resources) {
    if (resource.kind !== 'authentication-key' && resource.kind !== 'signing-key') continue;
    try {
      const collection = resource.kind === 'authentication-key' ? 'keys' : 'ssh_signing_keys';
      const candidates = await read(resource.account.login, `user/${collection}?per_page=100`);
      assert.ok(
        Array.isArray(candidates) && candidates.length < 100,
        'test-resource-key-collection-incomplete',
      );
      const matches = candidates
        .map(object)
        .filter((key) => parseSshPublicKey(String(key.key)).fingerprint === resource.fingerprint);
      assert.ok(matches.length <= 1, 'test-resource-key-ambiguous');
      if (matches[0]) resource.id = Number(matches[0].id);
    } catch {
      receipt.problems.push('key-id-collection-failed');
    }
  }
  const config = process.env.XDG_CONFIG_HOME;
  if (config && receipt.resources.some(({ kind }) => kind === 'issue')) {
    const directory = join(config, 'tanaab/agent-system/agent-system-dispatch-v2');
    let files: string[] = [];
    try {
      files = (await readdir(directory)).filter((name) =>
        /^openclaw-dispatch-.*\.json$/u.test(name),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        receipt.problems.push('native-delivery-collection-failed');
    }
    for (const file of files) {
      try {
        const state = object(JSON.parse(await readFile(join(directory, file), 'utf8')));
        assert.ok(Array.isArray(state.records), 'test-resource-native-state-invalid');
        for (const raw of state.records) {
          const record = object(raw);
          const issueId = object(object(record.stageReceipt).binding).subjectId;
          if (
            !receipt.resources.some(
              (resource) => resource.kind === 'issue' && resource.nodeId === issueId,
            )
          )
            continue;
          if (!record.work || !object(record.work).delivery) continue;
          const delivery = object(object(record.work).delivery);
          if (!delivery.pullRequest) continue;
          const pull = object(delivery.pullRequest);
          if (
            receipt.resources.some(
              (resource) =>
                resource.kind === 'pull-request' && resource.nodeId === pull.pullRequestNodeId,
            )
          )
            continue;
          const binding = object(delivery.binding);
          const account = await identity('tanaabot');
          receipt.resources.push({
            kind: 'pull-request',
            receiptId: `pull:${pull.pullRequestNodeId}`,
            repository: testBucket,
            account,
            number: Number(pull.pullRequestNumber),
            nodeId: String(pull.pullRequestNodeId),
            issueNodeId: String(issueId),
            branch: String(binding.branch),
            headSha: String(delivery.pushedHead ?? binding.head),
          });
        }
      } catch {
        receipt.problems.push('native-delivery-collection-failed');
      }
    }
  }
  receipt.problems = [...new Set(receipt.problems)];
  receipt.finished = true;
  receipt.sequence++;
  await checkpoint(receipt);
}

function redact(value: unknown): string {
  let json = JSON.stringify(value);
  // Only selected public provider records are archived. Still redact any declared
  // CI credentials should an upstream comment accidentally contain one.
  for (const name of [
    'GITHUB_TOKEN',
    'GH_TOKEN_TANAABOT',
    'GH_TOKEN_EMORI',
    'OP_SERVICE_ACCOUNT_TOKEN',
    'ACTIONS_RUNTIME_TOKEN',
  ]) {
    const secret = process.env[name];
    if (secret) json = json.split(secret).join('[REDACTED]');
  }
  return json.replace(
    /(?:gh[pousr]_|github_pat_|ops_|sk-ant-|sk-proj-|ya29\.)[A-Za-z0-9_.-]+/gu,
    '[REDACTED]',
  );
}
async function uploadJson(name: string, value: unknown) {
  const directory = join(required('RUNNER_TEMP'), name);
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'report.json');
  const data = redact(value);
  assert.ok(Buffer.byteLength(data) <= 8 * 1024 * 1024, 'test-resource-evidence-too-large');
  await writeFile(path, data, { mode: 0o600 });
  const uploaded = await artifacts.uploadArtifact(name, [path], directory, { retentionDays: 14 });
  assert.ok(uploaded.id, 'test-resource-evidence-unacknowledged');
}
async function cleanup(runId: number, attempt: number) {
  assert.ok(
    Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(attempt) && attempt > 0,
    'test-resource-source-required',
  );
  const repository = required('GITHUB_REPOSITORY');
  assert.equal(
    repository,
    'tanaabased/openclaw-agent-system',
    'test-resource-source-repository-invalid',
  );
  const base = `repos/${repository}/actions/runs/${runId}`;
  const raw = object(await read('actions', `${base}/attempts/${attempt}`));
  assert.equal(
    object(raw.repository).id,
    Number(required('GITHUB_REPOSITORY_ID')),
    'test-resource-source-repository-invalid',
  );
  assert.equal(
    object(raw.head_repository).id,
    object(raw.repository).id,
    'test-resource-fork-run-not-eligible',
  );
  assert.equal(raw.run_attempt, attempt, 'test-resource-source-attempt-mismatch');
  const jobs: TestResourceRun['jobs'] = [];
  for (let page = 1; page <= 10; page++) {
    const response = object(
      await read('actions', `${base}/attempts/${attempt}/jobs?per_page=100&page=${page}`),
    );
    assert.ok(Array.isArray(response.jobs), 'test-resource-jobs-invalid');
    jobs.push(
      ...response.jobs.map((entry) => {
        const job = object(entry);
        assert.ok(
          Array.isArray(job.labels) && job.labels.every((label) => typeof label === 'string'),
          'test-resource-job-labels-invalid',
        );
        return {
          id: Number(job.id),
          name: String(job.name),
          status: String(job.status),
          startedAt: String(job.started_at ?? ''),
          completedAt: String(job.completed_at ?? ''),
          labels: job.labels as string[],
        };
      }),
    );
    if (jobs.length === response.total_count) break;
    assert.ok(page < 10, 'test-resource-job-page-limit');
  }
  const run: TestResourceRun = {
    repository,
    repositoryId: Number(object(raw.repository).id),
    runId,
    attempt,
    workflow: String(raw.path),
    status: String(raw.status),
    startedAt: String(raw.run_started_at),
    completedAt: String(raw.updated_at),
    jobs,
  };
  authorizeTestResourceCleanup(run, []); // before any bot credential is read
  const receipts: TestResourceReceipt[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = object(await read('actions', `${base}/artifacts?per_page=100&page=${page}`));
    assert.ok(Array.isArray(response.artifacts), 'test-resource-artifacts-invalid');
    for (const entry of response.artifacts) {
      const artifact = object(entry);
      if (!String(artifact.name).startsWith(`test-resources-${runId}-${attempt}-`)) continue;
      assert.ok(
        !artifact.expired &&
          Number(artifact.size_in_bytes) <= receiptLimit &&
          Number.isSafeInteger(artifact.id),
        'test-resource-artifact-unavailable',
      );
      const download: Response = await fetch(
        `https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`,
        {
          headers: { authorization: `Bearer ${token('actions')}` },
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        },
      );
      assert.equal(download.status, 302, 'test-resource-artifact-download-failed');
      const location = new URL(download.headers.get('location') ?? '');
      assert.equal(location.protocol, 'https:', 'test-resource-artifact-url-invalid');
      const archive = await fetch(location, {
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      assert.equal(archive.status, 200, 'test-resource-artifact-download-failed');
      const receipt = readReceiptArchive(await boundedBytes(archive, receiptLimit));
      assert.equal(
        receiptArtifactName(receipt),
        artifact.name,
        'test-resource-artifact-name-mismatch',
      );
      const job = jobs.find(({ name }) => name === receipt.source.jobName);
      assert.ok(
        job &&
          Date.parse(String(artifact.created_at)) >= Date.parse(job.startedAt) &&
          Date.parse(String(artifact.created_at)) <= Date.parse(job.completedAt),
        'test-resource-artifact-window-mismatch',
      );
      receipts.push(receipt);
    }
    if (response.artifacts.length < 100) break;
    assert.ok(page < 20, 'test-resource-artifact-page-limit');
  }
  const report = await cleanupTestResources({
    run,
    receipts,
    request: providerRequest,
    captureEvidence: (snapshots) =>
      uploadJson(
        `test-cleanup-evidence-${runId}-${attempt}-${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}`,
        snapshots,
      ),
  });
  core.info(JSON.stringify(report));
  await core.summary
    .addHeading(`Test resource cleanup: ${report.status}`)
    .addRaw(`Source run ${runId}, attempt ${attempt}.\n\n`)
    .addCodeBlock(JSON.stringify(report.outcomes, null, 2), 'json')
    .write();
  await uploadJson(
    `test-cleanup-report-${runId}-${attempt}-${required('GITHUB_RUN_ID')}-${required('GITHUB_RUN_ATTEMPT')}`,
    report,
  );
  if (report.status !== 'complete')
    core.setFailed('test-resource-cleanup-partial: see the cleanup report for retained targets');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'test-resource-github-actions-only');
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        manifest: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        'body-file': { type: 'string' },
        output: { type: 'string' },
      },
    });
    const operation = process.env.INPUT_OPERATION || positionals[0];
    if (operation === 'prepare')
      await prepare(
        core.getInput('scenario', { required: true }),
        core.getInput('os', { required: true }),
      );
    else if (operation === 'keys') await keys(resolve(values.manifest ?? 'agent.yaml'));
    else if (operation === 'create-issue')
      await createIssue(
        values.title ?? '',
        values['body-file'] ? await readFile(values['body-file'], 'utf8') : (values.body ?? ''),
        values.output ?? '',
      );
    else if (operation === 'finish') await finish();
    else if (operation === 'cleanup')
      await cleanup(Number(core.getInput('run-id')), Number(core.getInput('attempt')));
    else throw new Error('test-resource-operation-invalid');
  } catch (error) {
    const message =
      error instanceof Error
        ? (error.message.match(/^test-resource-[a-z0-9-]+(?::[A-Z_]+)?/u)?.[0] ??
          'test-resource-operation-failed')
        : 'test-resource-operation-failed';
    core.setFailed(message);
  }
}
