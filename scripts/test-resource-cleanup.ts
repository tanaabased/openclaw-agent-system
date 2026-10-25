import parseSshPublicKey from '../utils/parse-ssh-public-key.ts';
import {
  mergeReceiptCheckpoints,
  testBucket,
  testBucketId,
  type TestResource,
  type TestResourceAccount,
  type TestResourceReceipt,
} from './test-resource-receipts.ts';

export const exampleWorkflows = [
  '.github/workflows/pr-examples-codex.yml',
  '.github/workflows/pr-examples-notifications.yml',
  '.github/workflows/pr-examples-openclaw.yml',
  '.github/workflows/pr-examples-os.yml',
];
export interface TestResourceJob {
  id: number;
  name: string;
  status: string;
  startedAt: string;
  completedAt: string;
  labels: string[];
}
export interface TestResourceRun {
  repository: string;
  repositoryId: number;
  runId: number;
  attempt: number;
  workflow: string;
  status: string;
  startedAt: string;
  completedAt: string;
  jobs: TestResourceJob[];
}
export interface TestResourceResponse {
  status: number;
  value: unknown;
}
export type TestResourceRequest = (
  account: 'actions' | TestResourceAccount['login'],
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  route: string,
  body?: Record<string, unknown>,
) => Promise<TestResourceResponse>;
export interface TestCleanupOutcome {
  effect: TestResource['kind'] | 'branch' | 'inventory';
  target: string;
  status: 'deleted' | 'closed' | 'absent' | 'preserved' | 'failed';
  code?: string;
}

export function testResourceObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('test-resource-provider-shape-invalid');
  return value as Record<string, unknown>;
}

function successful(response: TestResourceResponse): unknown {
  const errors =
    response.value && typeof response.value === 'object' && 'errors' in response.value
      ? response.value.errors
      : undefined;
  if (response.status < 200 || response.status >= 300 || errors)
    throw new Error(`test-resource-provider-${response.status}`);
  return response.value;
}

function inJob(value: unknown, job: TestResourceJob): boolean {
  const created = typeof value === 'string' ? Date.parse(value) : NaN;
  return created >= Date.parse(job.startedAt) && created <= Date.parse(job.completedAt);
}

function accountMatches(value: unknown, account: TestResourceAccount): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const user = testResourceObject(value);
  return user.login === account.login && user.node_id === account.nodeId;
}

export function authorizeTestResourceCleanup(
  run: TestResourceRun,
  receipts: TestResourceReceipt[],
): TestResourceReceipt[] {
  if (
    run.repository !== 'tanaabased/openclaw-agent-system' ||
    !exampleWorkflows.includes(run.workflow) ||
    run.status !== 'completed' ||
    run.jobs.some(({ status, labels }) => status !== 'completed' || labels.includes('self-hosted'))
  )
    throw new Error('test-resource-run-not-eligible');
  const merged = mergeReceiptCheckpoints(receipts);
  if (merged.reduce((sum, receipt) => sum + receipt.resources.length, 0) > 512)
    throw new Error('test-resource-inventory-too-large');
  for (const receipt of merged) {
    const source = receipt.source;
    const jobs = run.jobs.filter(({ name }) => name === source.jobName);
    if (
      source.repository !== run.repository ||
      source.repositoryId !== run.repositoryId ||
      source.runId !== run.runId ||
      source.attempt !== run.attempt ||
      source.workflow !== run.workflow ||
      source.jobName !== `${source.scenario} (${source.os})` ||
      jobs.length !== 1 ||
      !jobs[0]!.labels.includes(source.os) ||
      !Number.isFinite(Date.parse(jobs[0]!.startedAt)) ||
      !Number.isFinite(Date.parse(jobs[0]!.completedAt))
    )
      throw new Error('test-resource-source-mismatch');
  }
  return merged;
}

/** cleanup reads exact ownership before writes and retains independent category failures. */
export default async function cleanupTestResources(input: {
  run: TestResourceRun;
  receipts: TestResourceReceipt[];
  request: TestResourceRequest;
  captureEvidence(snapshots: unknown[]): Promise<void>;
}) {
  const receipts = authorizeTestResourceCleanup(input.run, input.receipts);
  const outcomes: TestCleanupOutcome[] = [];
  const snapshots: unknown[] = [];
  const accounts = new Map<string, Promise<void>>();
  const repositories = new Map<string, Promise<{ admin: boolean }>>();
  const request = input.request;
  const get = async (account: TestResourceAccount['login'], route: string) =>
    request(account, 'GET', route);
  const identify = (account: TestResourceAccount) => {
    const identity = `${account.login}:${account.nodeId}`;
    if (!accounts.has(identity))
      accounts.set(
        identity,
        (async () => {
          if (!accountMatches(successful(await get(account.login, 'user')), account))
            throw new Error('test-resource-account-mismatch');
        })(),
      );
    return accounts.get(identity)!;
  };
  const repository = async (account: TestResourceAccount) => {
    await identify(account);
    if (!repositories.has(account.login))
      repositories.set(
        account.login,
        (async () => {
          const repo = testResourceObject(
            successful(await get(account.login, `repos/${testBucket}`)),
          );
          if (repo.id !== testBucketId || repo.full_name !== testBucket)
            throw new Error('test-resource-repository-mismatch');
          return {
            admin: Boolean(repo.permissions && testResourceObject(repo.permissions).admin === true),
          };
        })(),
      );
    return repositories.get(account.login)!;
  };
  const list = async (account: TestResourceAccount['login'], route: string, before?: number) => {
    const items: Record<string, unknown>[] = [];
    for (let page = 1; page <= 20; page++) {
      const value = successful(
        await get(account, `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`),
      );
      if (!Array.isArray(value)) throw new Error('test-resource-provider-shape-invalid');
      items.push(...value.map(testResourceObject));
      if (
        value.length < 100 ||
        (before !== undefined &&
          value.some((item) => Date.parse(String(testResourceObject(item).created_at)) < before))
      )
        return items;
    }
    throw new Error('test-resource-provider-page-limit');
  };
  const add = (
    effect: TestCleanupOutcome['effect'],
    target: string,
    status: TestCleanupOutcome['status'],
    code?: string,
  ) => outcomes.push({ effect, target, status, ...(code ? { code } : {}) });
  const failure = (effect: TestCleanupOutcome['effect'], target: string, error: unknown) =>
    add(
      effect,
      target,
      'failed',
      error instanceof Error && /^test-resource-[a-z0-9-]+$/u.test(error.message)
        ? error.message
        : 'test-resource-operation-failed',
    );
  const absentNode = async (account: TestResourceAccount['login'], nodeId: string) => {
    const response = await request(account, 'POST', 'graphql', {
      query: 'query($id:ID!){node(id:$id){id}}',
      variables: { id: nodeId },
    });
    const value = testResourceObject(response.value);
    const errors = value.errors;
    if (
      response.status !== 200 ||
      (errors &&
        (!Array.isArray(errors) ||
          errors.some((error) => testResourceObject(error).type !== 'NOT_FOUND')))
    )
      throw new Error('test-resource-absence-unverified');
    return testResourceObject(value.data).node === null;
  };
  const ownedIssues: Array<{
    resource: Extract<TestResource, { kind: 'issue' }>;
    job: TestResourceJob;
    value: Record<string, unknown>;
    admin: boolean;
  }> = [];
  const pulls: Array<{
    resource: Extract<TestResource, { kind: 'pull-request' }>;
    job: TestResourceJob;
    inferred: boolean;
  }> = [];

  for (const receipt of receipts) {
    const job = input.run.jobs.find(({ name }) => name === receipt.source.jobName)!;
    for (const original of receipt.resources) {
      const resource = structuredClone(original);
      if (resource.kind === 'pull-request') {
        if (
          !receipt.resources.some(
            (other) => other.kind === 'issue' && other.nodeId === resource.issueNodeId,
          )
        ) {
          add(
            resource.kind,
            String(resource.number),
            'preserved',
            'test-resource-issue-link-mismatch',
          );
          continue;
        }
        pulls.push({ resource, job, inferred: false });
        continue;
      }
      if (resource.kind === 'issue') {
        try {
          const access = await repository(resource.account);
          if (!resource.number) {
            const candidates = (
              await list(
                resource.account.login,
                `repos/${testBucket}/issues?state=all&since=${encodeURIComponent(job.startedAt)}`,
              )
            ).filter(
              (candidate) =>
                !candidate.pull_request &&
                typeof candidate.body === 'string' &&
                candidate.body.includes(resource.marker) &&
                accountMatches(candidate.user, resource.account) &&
                inJob(candidate.created_at, job),
            );
            if (candidates.length > 1) throw new Error('test-resource-issue-ambiguous');
            const candidate = candidates[0];
            if (!candidate) {
              add(resource.kind, resource.receiptId, 'absent');
              continue;
            }
            resource.number = Number(candidate.number);
            resource.nodeId = String(candidate.node_id);
          }
          const observed = await get(
            resource.account.login,
            `repos/${testBucket}/issues/${resource.number}`,
          );
          if ([404, 410].includes(observed.status)) {
            if (!(await absentNode(resource.account.login, resource.nodeId!)))
              throw new Error('test-resource-issue-moved');
            add(resource.kind, String(resource.number), 'absent');
            continue;
          }
          const value = testResourceObject(successful(observed));
          if (
            value.pull_request ||
            value.node_id !== resource.nodeId ||
            value.number !== resource.number ||
            !accountMatches(value.user, resource.account) ||
            !inJob(value.created_at, job) ||
            typeof value.body !== 'string' ||
            !value.body.includes(resource.marker)
          ) {
            add(
              resource.kind,
              String(resource.number),
              'preserved',
              'test-resource-issue-ownership-mismatch',
            );
            continue;
          }
          const comments = await list(
            resource.account.login,
            `repos/${testBucket}/issues/${resource.number}/comments`,
          );
          snapshots.push({ resource, issue: value, comments });
          ownedIssues.push({ resource, job, value, admin: access.admin });
        } catch (error) {
          failure(resource.kind, String(resource.number ?? resource.receiptId), error);
        }
        continue;
      }
      const collection = resource.kind === 'authentication-key' ? 'keys' : 'ssh_signing_keys';
      try {
        await identify(resource.account);
        const expected = parseSshPublicKey(resource.publicKey);
        if (
          expected.fingerprint !== resource.fingerprint ||
          !new RegExp(`(?:^|-)${input.run.runId}-${input.run.attempt}(?:-|$)`, 'u').test(
            resource.title,
          )
        )
          throw new Error('test-resource-key-intent-invalid');
        const visible = await list(resource.account.login, `user/${collection}`);
        if (!resource.id) {
          const candidates = visible.filter((candidate) => {
            try {
              return parseSshPublicKey(String(candidate.key)).fingerprint === expected.fingerprint;
            } catch {
              return false;
            }
          });
          if (candidates.length > 1) throw new Error('test-resource-key-ambiguous');
          if (!candidates[0]) {
            add(resource.kind, resource.fingerprint, 'absent');
            continue;
          }
          resource.id = Number(candidates[0].id);
        }
        if (!Number.isSafeInteger(resource.id) || resource.id < 1)
          throw new Error('test-resource-key-id-invalid');
        const route = `user/${collection}/${resource.id}`;
        const observed = await get(resource.account.login, route);
        if (observed.status === 404 && !visible.some(({ id }) => id === resource.id)) {
          add(resource.kind, String(resource.id), 'absent');
          continue;
        }
        const value = testResourceObject(successful(observed));
        if (
          value.id !== resource.id ||
          value.title !== resource.title ||
          parseSshPublicKey(String(value.key)).fingerprint !== expected.fingerprint ||
          !inJob(value.created_at, job)
        ) {
          add(
            resource.kind,
            String(resource.id),
            'preserved',
            'test-resource-key-ownership-mismatch',
          );
          continue;
        }
        const deleted = await request(resource.account.login, 'DELETE', route);
        if (deleted.status === 204) add(resource.kind, String(resource.id), 'deleted');
        else if (
          ![401, 403, 429].includes(deleted.status) &&
          (await get(resource.account.login, route)).status === 404
        )
          add(resource.kind, String(resource.id), 'absent');
        else {
          successful(deleted);
          throw new Error('test-resource-key-delete-unverified');
        }
      } catch (error) {
        failure(resource.kind, String(resource.id ?? resource.fingerprint), error);
      }
    }
  }

  const pullLinks = async (account: TestResourceAccount['login'], nodeId: string) => {
    const response = testResourceObject(
      successful(
        await request(account, 'POST', 'graphql', {
          query:
            'query($id:ID!){node(id:$id){... on PullRequest{closingIssuesReferences(first:100){nodes{id} pageInfo{hasNextPage}}}}}',
          variables: { id: nodeId },
        }),
      ),
    );
    const references = testResourceObject(
      testResourceObject(testResourceObject(response.data).node).closingIssuesReferences,
    );
    if (testResourceObject(references.pageInfo).hasNextPage || !Array.isArray(references.nodes))
      throw new Error('test-resource-pull-links-unavailable');
    return references.nodes.map((node) => String(testResourceObject(node).id));
  };
  let discoveryComplete = true;
  try {
    if (ownedIssues.length) {
      const account = ownedIssues[0]!.resource.account;
      const candidates = await list(
        account.login,
        `repos/${testBucket}/pulls?state=all&sort=created&direction=desc`,
        Math.min(...ownedIssues.map(({ job }) => Date.parse(job.startedAt))),
      );
      for (const candidate of candidates) {
        if (
          !ownedIssues.some(({ job }) => inJob(candidate.created_at, job)) ||
          pulls.some(({ resource }) => resource.nodeId === candidate.node_id)
        )
          continue;
        const links = await pullLinks(account.login, String(candidate.node_id));
        const owner = ownedIssues.find(
          ({ resource, job }) =>
            inJob(candidate.created_at, job) && links.includes(resource.nodeId!),
        );
        if (!owner) continue;
        const user = testResourceObject(candidate.user);
        const head = testResourceObject(candidate.head);
        if (user.login !== 'tanaabot' || testResourceObject(head.repo).id !== testBucketId)
          continue;
        pulls.push({
          resource: {
            kind: 'pull-request',
            receiptId: `pull:${candidate.node_id}`,
            repository: testBucket,
            account: { login: 'tanaabot', nodeId: String(user.node_id) },
            number: Number(candidate.number),
            nodeId: String(candidate.node_id),
            issueNodeId: owner.resource.nodeId!,
            branch: String(head.ref),
            headSha: String(head.sha),
          },
          job: owner.job,
          inferred: true,
        });
      }
    }
  } catch (error) {
    discoveryComplete = false;
    failure('inventory', 'pull-request-discovery', error);
  }

  const pendingPulls = new Set<string>();
  for (const { resource, job, inferred } of pulls) {
    try {
      const issueOwned = ownedIssues.some(
        (issue) => issue.resource.nodeId === resource.issueNodeId && issue.job.id === job.id,
      );
      await repository(resource.account);
      const route = `repos/${testBucket}/pulls/${resource.number}`;
      const value = testResourceObject(successful(await get(resource.account.login, route)));
      const head = testResourceObject(value.head);
      if (
        value.node_id !== resource.nodeId ||
        value.number !== resource.number ||
        !accountMatches(value.user, resource.account) ||
        !inJob(value.created_at, job) ||
        testResourceObject(head.repo).id !== testBucketId ||
        head.ref !== resource.branch ||
        (!inferred && head.sha !== resource.headSha)
      ) {
        add(
          resource.kind,
          String(resource.number),
          'preserved',
          'test-resource-pull-ownership-mismatch',
        );
        pendingPulls.add(resource.issueNodeId);
        continue;
      }
      if (!issueOwned) {
        // A retry may find the issue already deleted. It may verify completed
        // disposal, but missing ownership evidence never permits another write.
        if (value.state === 'closed') {
          add(resource.kind, String(resource.number), 'closed');
          const branch = await get(
            resource.account.login,
            `repos/${testBucket}/git/refs/heads/${encodeURIComponent(resource.branch)}`,
          );
          if (branch.status === 404) add('branch', resource.branch, 'absent');
          else {
            successful(branch);
            add('branch', resource.branch, 'preserved', 'test-resource-issue-link-unverified');
          }
        } else
          add(
            resource.kind,
            String(resource.number),
            'preserved',
            'test-resource-issue-link-unverified',
          );
        continue;
      }
      if (
        !(await pullLinks(resource.account.login, resource.nodeId)).includes(resource.issueNodeId)
      ) {
        add(
          resource.kind,
          String(resource.number),
          'preserved',
          'test-resource-pull-ownership-mismatch',
        );
        pendingPulls.add(resource.issueNodeId);
        continue;
      }
      const comments = await list(
        resource.account.login,
        `repos/${testBucket}/issues/${resource.number}/comments`,
      );
      snapshots.push({ resource, pullRequest: value, comments });
      if (value.state !== 'closed') {
        const closed = await request(resource.account.login, 'PATCH', route, { state: 'closed' });
        if ([401, 403, 429].includes(closed.status)) successful(closed);
        const observed = testResourceObject(successful(await get(resource.account.login, route)));
        if (observed.node_id !== resource.nodeId || observed.state !== 'closed')
          throw new Error('test-resource-pull-close-unverified');
      }
      add(resource.kind, String(resource.number), 'closed');
      if (inferred) {
        add('branch', resource.branch, 'preserved', 'test-resource-branch-receipt-missing');
        continue;
      }
      const branchRoute = `repos/${testBucket}/git/refs/heads/${encodeURIComponent(resource.branch)}`;
      const branch = await get(resource.account.login, branchRoute);
      if (branch.status === 404) {
        add('branch', resource.branch, 'absent');
        continue;
      }
      const ref = testResourceObject(successful(branch));
      if (testResourceObject(ref.object).sha !== resource.headSha) {
        add('branch', resource.branch, 'preserved', 'test-resource-branch-head-changed');
        continue;
      }
      successful(await request(resource.account.login, 'DELETE', branchRoute));
      add('branch', resource.branch, 'deleted');
    } catch (error) {
      pendingPulls.add(resource.issueNodeId);
      failure(resource.kind, String(resource.number), error);
    }
  }

  let evidenceCaptured = false;
  try {
    if (snapshots.length) await input.captureEvidence(snapshots);
    evidenceCaptured = true;
  } catch (error) {
    failure('inventory', 'failure-evidence', error);
  }
  for (const { resource, admin } of ownedIssues) {
    const target = String(resource.number);
    if (!evidenceCaptured || !discoveryComplete || pendingPulls.has(resource.nodeId!)) {
      add(
        resource.kind,
        target,
        'preserved',
        !evidenceCaptured
          ? 'test-resource-evidence-unavailable'
          : 'test-resource-pull-cleanup-pending',
      );
      continue;
    }
    try {
      if (!admin) {
        const route = `repos/${testBucket}/issues/${resource.number}`;
        const response = await request(resource.account.login, 'PATCH', route, { state: 'closed' });
        if ([401, 403, 429].includes(response.status)) successful(response);
        const observed = testResourceObject(successful(await get(resource.account.login, route)));
        if (observed.node_id !== resource.nodeId || observed.state !== 'closed')
          throw new Error('test-resource-issue-close-unverified');
        add(resource.kind, target, 'closed', 'test-resource-issue-delete-admin-required');
        continue;
      }
      const response = await request(resource.account.login, 'POST', 'graphql', {
        query:
          'mutation($id:ID!,$receipt:String!){deleteIssue(input:{issueId:$id,clientMutationId:$receipt}){clientMutationId}}',
        variables: { id: resource.nodeId, receipt: resource.receiptId },
      });
      if ([401, 403, 429].includes(response.status)) successful(response);
      const value =
        response.value && typeof response.value === 'object' && !Array.isArray(response.value)
          ? testResourceObject(response.value)
          : {};
      const data = value.data ? testResourceObject(value.data) : undefined;
      if (
        !value.errors &&
        data &&
        data.deleteIssue &&
        testResourceObject(data.deleteIssue).clientMutationId === resource.receiptId
      )
        add(resource.kind, target, 'deleted');
      else if (
        value.errors &&
        Array.isArray(value.errors) &&
        value.errors.some((error) =>
          ['FORBIDDEN', 'UNAUTHORIZED', 'RATE_LIMITED'].includes(
            String(testResourceObject(error).type),
          ),
        )
      )
        throw new Error('test-resource-issue-delete-denied');
      else if (await absentNode(resource.account.login, resource.nodeId!))
        add(resource.kind, target, 'absent');
      else throw new Error('test-resource-issue-delete-unverified');
    } catch (error) {
      failure(resource.kind, target, error);
    }
  }
  const missing = input.run.jobs.filter(
    ({ name, startedAt }) => startedAt && !receipts.some(({ source }) => source.jobName === name),
  );
  for (const job of missing)
    add('inventory', String(job.id), 'preserved', 'test-resource-job-receipts-missing');
  for (const receipt of receipts)
    if (!receipt.finished)
      add(
        'inventory',
        receipt.source.jobName,
        'preserved',
        'test-resource-final-checkpoint-missing',
      );
  for (const receipt of receipts)
    for (const code of receipt.problems)
      add('inventory', receipt.source.jobName, 'preserved', `test-resource-${code}`);
  return {
    status: outcomes.some(({ status }) => status === 'preserved' || status === 'failed')
      ? ('partial' as const)
      : ('complete' as const),
    runId: input.run.runId,
    attempt: input.run.attempt,
    outcomes,
  };
}
