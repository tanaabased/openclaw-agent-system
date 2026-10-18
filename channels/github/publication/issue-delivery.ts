import { githubCliDiagnostic } from '../../../credentials/github-diagnostic.ts';
import { parseGitHubApiResponse } from '../provider/api-response.ts';
import {
  withProviderDiagnostic,
  type ProviderDiagnostic,
} from '../../../utils/provider-diagnostic.ts';
import type { GitHubIdentityPin, GitHubPullRequestRecipient } from '../config-schema.ts';
import { githubIdentitySet } from '../provider/work-item.ts';
import resolvePullRequestRecipients from '../pull-request-recipients.ts';
import abortableDelay from '../../../utils/abortable-delay.ts';
import type { ConnectedGitHubAccountClient } from '../../../core/github-account-client.ts';

export interface GitHubNotificationIssueDeliveryReceipt {
  pullRequestNodeId: string;
  pullRequestNumber: number;
}

export type GitHubIssueDeliveryFailureCategory =
  'github-request' | 'invalid-response' | 'identity-mismatch';

export class GitHubIssueDeliveryError extends Error {
  override name = 'GitHubIssueDeliveryError';

  constructor(
    readonly category: GitHubIssueDeliveryFailureCategory,
    message: string,
    readonly providerDiagnostic?: ProviderDiagnostic,
  ) {
    super(withProviderDiagnostic(message, providerDiagnostic));
  }
}

export interface IssueDeliveryInput {
  item: {
    number: number;
    itemDatabaseId: number;
    itemNodeId: string;
    repositoryOwner: string;
    repositoryName: string;
    repositoryDefaultBranch: string;
    assignmentActorLogin?: string;
    assignmentActorNodeId?: string;
  };
  branch: string;
  title?: string;
  body?: string;
  signal?: AbortSignal;
  recipients?: GitHubPullRequestRecipient[];
  expectedPullRequest?: GitHubNotificationIssueDeliveryReceipt;
  headSha?: string;
  repositoryNodeId?: string;
  linkIssue?: boolean;
  contentUpdate?: { title?: string; body?: string };
  beforeCreate?: () => Promise<void>;
  onLinkageRetry?: () => Promise<void>;
  checkpoint?: (receipt: GitHubNotificationIssueDeliveryReceipt) => Promise<void>;
}

interface IssueIdentity {
  title: string;
}

interface PullRequestIdentity {
  baseRef: string;
  body: string;
  headRef: string;
  headRepository: string;
  itemNodeId: string;
  number: number;
  state: string;
  title: string;
}

const loginPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximumLength ||
    value.includes('\0')
  ) {
    throw new Error(`GitHub returned an invalid ${label}.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string' || value.length > maximumLength || value.includes('\0')) {
    throw new Error(`GitHub returned an invalid ${label}.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`GitHub returned an invalid ${label}.`);
  }
  return Number(value);
}

function parseIssue(value: unknown, item: IssueDeliveryInput['item']): IssueIdentity {
  const issue = record(value, 'issue delivery context');
  if (
    positiveInteger(issue.databaseId, 'issue database id') !== item.itemDatabaseId ||
    requiredString(issue.nodeId, 'issue node id', 255) !== item.itemNodeId ||
    positiveInteger(issue.number, 'issue number') !== item.number
  ) {
    throw new Error('GitHub returned a different issue during delivery.');
  }
  return {
    title: requiredString(issue.title, 'issue title', 512).trim(),
  };
}

function identities(value: unknown, label: string): GitHubIdentityPin[] {
  if (!Array.isArray(value)) throw new Error(`GitHub returned invalid ${label}.`);
  return value.map((entry) => {
    const identity = record(entry, label);
    const login = requiredString(identity.login, `${label} login`, 100);
    if (!loginPattern.test(login)) throw new Error(`GitHub returned invalid ${label} login.`);
    return { login, nodeId: requiredString(identity.nodeId, `${label} node id`, 255) };
  });
}

function logins(value: unknown, label: string): Set<string> {
  if (
    !Array.isArray(value) ||
    !value.every((login) => typeof login === 'string' && loginPattern.test(login))
  ) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return new Set((value as string[]).map((login) => login.toLowerCase()));
}

function parsePullRequest(value: unknown): PullRequestIdentity {
  const pullRequest = record(value, 'pull request delivery context');
  return {
    baseRef: requiredString(pullRequest.baseRef, 'pull request base ref', 255),
    body:
      pullRequest.body === null || pullRequest.body === undefined
        ? ''
        : boundedString(pullRequest.body, 'pull request body', 65_536),
    headRef: requiredString(pullRequest.headRef, 'pull request head ref', 255),
    headRepository: requiredString(pullRequest.headRepository, 'pull request head repository', 255),
    itemNodeId: requiredString(pullRequest.itemNodeId, 'pull request node id', 255),
    number: positiveInteger(pullRequest.number, 'pull request number'),
    state: requiredString(pullRequest.state, 'pull request state', 32),
    title: requiredString(pullRequest.title, 'pull request title', 512),
  };
}

function pullRequestProjection() {
  return '{baseRef:.base.ref,body,headRef:.head.ref,headRepository:(.head.repo.full_name//""),itemNodeId:.node_id,number,state,title}';
}

function hasClosingReference(body: string, repository: string, number: number): boolean {
  const references = new Set([
    `#${number}`,
    `${repository}#${number}`.toLowerCase(),
    `https://github.com/${repository}/issues/${number}`.toLowerCase(),
  ]);
  const pattern =
    /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?):?\s+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|(?:[\w.-]+\/[\w.-]+)?#\d+)(?=$|[\s.,;:!?])/giu;
  return [...body.matchAll(pattern)].some((match) => references.has(match[1]!.toLowerCase()));
}

/** provider operations shared by runtime-owned delivery wrappers. */
export default class IssueDeliveryProvider {
  constructor(
    readonly client: Pick<ConnectedGitHubAccountClient, 'execute' | 'identity'>,
    private readonly delay = abortableDelay,
  ) {}
  async inspect(
    input: IssueDeliveryInput,
  ): Promise<GitHubNotificationIssueDeliveryReceipt | undefined> {
    const pullRequest = await this.#find(input);
    if (!pullRequest) return undefined;
    await this.#verify(input, pullRequest, false);
    return { pullRequestNodeId: pullRequest.itemNodeId, pullRequestNumber: pullRequest.number };
  }

  /** read the provider state and closing association before an issue announcement. */
  async announcement(input: IssueDeliveryInput) {
    if (!input.expectedPullRequest || !input.headSha || !input.repositoryNodeId)
      throw new Error('delivery-announcement-binding-required');
    const pullRequest = await this.#find(input);
    if (!pullRequest) throw new Error('delivery-announcement-pr-missing');
    await this.#verify(input, pullRequest, false);
    parseIssue(
      await this.#github(
        this.client,
        [
          'api',
          `repos/${input.item.repositoryOwner}/${input.item.repositoryName}/issues/${input.item.number}`,
          '--jq',
          '{databaseId:.id,nodeId:.node_id,number,title}',
        ],
        input.signal,
      ),
      input.item,
    );
    if (!(await this.#linkedIssue(input, pullRequest)))
      throw new Error('github-delivery-linkage-unverified');
    const observed = record(
      await this.#github(
        this.client,
        [
          'api',
          `repos/${input.item.repositoryOwner}/${input.item.repositoryName}/pulls/${pullRequest.number}`,
          '--jq',
          '{nodeId:.node_id,draft,state,head:.head.sha,title,body}',
        ],
        input.signal,
      ),
      'announcement pull request',
    );
    if (
      observed.nodeId !== pullRequest.itemNodeId ||
      observed.state !== 'open' ||
      observed.head !== input.headSha ||
      typeof observed.draft !== 'boolean'
    )
      throw new Error('delivery-announcement-state-unverified');
    return {
      pullRequestNodeId: pullRequest.itemNodeId,
      pullRequestNumber: pullRequest.number,
      draft: observed.draft,
      head: input.headSha,
      title: requiredString(observed.title, 'pull request title', 512),
      body: boundedString(observed.body ?? '', 'pull request body', 65536),
    };
  }

  async #find(input: IssueDeliveryInput): Promise<PullRequestIdentity | undefined> {
    const github = this.client;
    const repository = `${input.item.repositoryOwner}/${input.item.repositoryName}`;
    const pullRequests = await this.#github(
      github,
      [
        'api',
        '--method',
        'GET',
        `repos/${repository}/pulls`,
        '-f',
        'state=all',
        '-f',
        `head=${input.item.repositoryOwner}:${input.branch}`,
        '--jq',
        `[.[]|${pullRequestProjection()}]`,
      ],
      input.signal,
    );
    if (!Array.isArray(pullRequests) || pullRequests.length > 1) {
      throw new Error('GitHub returned an ambiguous pull request for the managed branch.');
    }
    if (input.expectedPullRequest) {
      const existing = pullRequests.length === 1 ? parsePullRequest(pullRequests[0]) : undefined;
      if (
        !existing ||
        existing.itemNodeId !== input.expectedPullRequest.pullRequestNodeId ||
        existing.number !== input.expectedPullRequest.pullRequestNumber
      ) {
        throw new GitHubIssueDeliveryError(
          'identity-mismatch',
          'The managed branch no longer matches the linked task pull request.',
        );
      }
    }
    return pullRequests.length === 1 ? parsePullRequest(pullRequests[0]) : undefined;
  }

  async #verify(
    input: IssueDeliveryInput,
    pullRequest: PullRequestIdentity,
    normalize: boolean,
  ): Promise<void> {
    const github = this.client;
    const branch = input.branch;
    const repository = `${input.item.repositoryOwner}/${input.item.repositoryName}`;
    if (
      pullRequest.headRef !== branch ||
      pullRequest.headRepository.toLowerCase() !== repository.toLowerCase() ||
      pullRequest.state !== 'open'
    ) {
      throw new Error('The managed branch belongs to an incompatible pull request.');
    }

    if (input.headSha !== undefined) {
      const observed = record(
        await this.#github(
          github,
          [
            'api',
            `repos/${repository}/pulls/${pullRequest.number}`,
            '--jq',
            '{nodeId:.node_id,repositoryId:.base.repo.node_id,headRepositoryId:.head.repo.node_id,headSha:.head.sha,authorId:.user.node_id,baseRef:.base.ref,headRef:.head.ref,state,number}',
          ],
          input.signal,
        ),
        'pull request binding',
      );
      if (
        observed.nodeId !== pullRequest.itemNodeId ||
        observed.repositoryId !== input.repositoryNodeId ||
        observed.headRepositoryId !== input.repositoryNodeId ||
        observed.headSha !== input.headSha ||
        observed.authorId !== github.identity.nodeId ||
        observed.baseRef !== input.item.repositoryDefaultBranch ||
        observed.headRef !== branch ||
        observed.state !== 'open' ||
        observed.number !== pullRequest.number
      )
        throw new GitHubIssueDeliveryError(
          'identity-mismatch',
          'The pull request does not match the verified repository, author and head.',
        );
    }
    if (!normalize && pullRequest.baseRef !== input.item.repositoryDefaultBranch) {
      throw new Error('The task pull request targets a different base branch.');
    }
    if (!normalize && input.headSha === undefined) {
      const authorResponse = await this.#github(
        github,
        [
          'api',
          `repos/${repository}/pulls/${pullRequest.number}`,
          '--jq',
          '{nodeId:.user.node_id}',
        ],
        input.signal,
      );
      let authorNodeId: string;
      try {
        const author = record(authorResponse, 'pull request author');
        authorNodeId = requiredString(author.nodeId, 'pull request author node id', 255);
      } catch {
        throw new GitHubIssueDeliveryError(
          'invalid-response',
          'GitHub returned an invalid pull request author.',
        );
      }
      if (authorNodeId !== github.identity.nodeId) {
        throw new GitHubIssueDeliveryError(
          'identity-mismatch',
          'The task pull request was not created by the active agent.',
        );
      }
    }
  }

  async publish(
    input: IssueDeliveryInput,
    normalize = false,
  ): Promise<GitHubNotificationIssueDeliveryReceipt> {
    const github = this.client;
    const branch = input.branch;
    const repository = `${input.item.repositoryOwner}/${input.item.repositoryName}`;
    const issue = parseIssue(
      await this.#github(
        github,
        [
          'api',
          `repos/${repository}/issues/${input.item.number}`,
          '--jq',
          '{databaseId:.id,nodeId:.node_id,number,title}',
        ],
        input.signal,
      ),
      input.item,
    );
    const existing = await this.#find(input);
    if (!existing) await input.beforeCreate?.();
    let pullRequest = !existing
      ? parsePullRequest(
          await this.#github(
            github,
            [
              'api',
              '--method',
              'POST',
              `repos/${repository}/pulls`,
              '--input',
              '-',
              '--jq',
              pullRequestProjection(),
            ],
            input.signal,
            JSON.stringify({
              base: input.item.repositoryDefaultBranch,
              body: normalize
                ? `Closes #${input.item.number}`
                : (input.body ?? `Closes #${input.item.number}`),
              head: branch,
              title: normalize ? issue.title : (input.title ?? issue.title),
            }),
          ),
        )
      : existing;
    await this.#verify(input, pullRequest, normalize);
    const body = `Closes #${input.item.number}`;
    await input.checkpoint?.({
      pullRequestNodeId: pullRequest.itemNodeId,
      pullRequestNumber: pullRequest.number,
    });
    if (existing && input.contentUpdate && !normalize) {
      const title = input.contentUpdate.title ?? pullRequest.title;
      let body = input.contentUpdate.body ?? pullRequest.body;
      if (input.linkIssue && !hasClosingReference(body, repository, input.item.number))
        body =
          `${body.trimEnd()}\n\nCloses https://github.com/${repository}/issues/${input.item.number}`.trim();
      if (body.length > 65_536) throw new Error('github-delivery-body-too-large');
      if (pullRequest.title !== title || pullRequest.body !== body) {
        pullRequest = parsePullRequest(
          await this.#github(
            github,
            [
              'api',
              '--method',
              'PATCH',
              `repos/${repository}/pulls/${pullRequest.number}`,
              '--input',
              '-',
              '--jq',
              pullRequestProjection(),
            ],
            input.signal,
            JSON.stringify({ title, body }),
          ),
        );
        await this.#verify(input, pullRequest, false);
        if (
          pullRequest.itemNodeId !== existing.itemNodeId ||
          pullRequest.number !== existing.number ||
          pullRequest.title !== title ||
          pullRequest.body !== body
        )
          throw new Error('github-delivery-content-unverified');
      }
    }
    if (input.linkIssue && !(await this.#linkedIssue(input, pullRequest))) {
      const reference = `Closes https://github.com/${repository}/issues/${input.item.number}`;
      let linked = false;
      if (!hasClosingReference(pullRequest.body, repository, input.item.number)) {
        const linkedBody = `${pullRequest.body.trimEnd()}\n\n${reference}`.trim();
        if (linkedBody.length > 65_536) throw new Error('github-delivery-body-too-large');
        await this.#github(
          github,
          [
            'api',
            '--method',
            'PATCH',
            `repos/${repository}/pulls/${pullRequest.number}`,
            '--input',
            '-',
            '--jq',
            pullRequestProjection(),
          ],
          input.signal,
          JSON.stringify({ body: linkedBody }),
        );
        linked = await this.#linkedIssue(input, pullRequest);
      }
      for (const milliseconds of [250, 750, 1500]) {
        if (linked) break;
        await this.delay(milliseconds, input.signal);
        linked = await this.#linkedIssue(input, pullRequest);
        if (linked) await input.onLinkageRetry?.();
      }
      if (!linked) throw new Error('github-delivery-linkage-unverified');
    }
    if (
      normalize &&
      (pullRequest.baseRef !== input.item.repositoryDefaultBranch ||
        pullRequest.body !== body ||
        pullRequest.title !== issue.title)
    ) {
      pullRequest = parsePullRequest(
        await this.#github(
          github,
          [
            'api',
            '--method',
            'PATCH',
            `repos/${repository}/pulls/${pullRequest.number}`,
            '--input',
            '-',
            '--jq',
            pullRequestProjection(),
          ],
          input.signal,
          JSON.stringify({
            base: input.item.repositoryDefaultBranch,
            body,
            title: issue.title,
          }),
        ),
      );
    }
    await this.#reconcileRecipients(
      github,
      input.recipients,
      input,
      repository,
      pullRequest.number,
    );
    if (
      normalize &&
      (pullRequest.baseRef !== input.item.repositoryDefaultBranch ||
        pullRequest.body !== body ||
        pullRequest.title !== issue.title)
    ) {
      throw new Error('GitHub did not retain the normalized pull request shape.');
    }
    return {
      pullRequestNodeId: pullRequest.itemNodeId,
      pullRequestNumber: pullRequest.number,
    };
  }

  async #linkedIssue(
    input: IssueDeliveryInput,
    pullRequest: PullRequestIdentity,
  ): Promise<boolean> {
    const linked = record(
      await this.#github(
        this.client,
        ['api', 'graphql', '--input', '-', '--jq', '.data.node'],
        input.signal,
        JSON.stringify({
          query:
            'query($id:ID!){node(id:$id){... on PullRequest{id closingIssuesReferences(first:100){nodes{id}}}}}',
          variables: { id: pullRequest.itemNodeId },
        }),
      ),
      'pull request issue linkage',
    );
    const references = record(linked.closingIssuesReferences, 'closing issue references');
    if (linked.id !== pullRequest.itemNodeId || !Array.isArray(references.nodes))
      throw new Error('github-delivery-linkage-unverified');
    return references.nodes.some(
      (node) => record(node, 'closing issue reference').id === input.item.itemNodeId,
    );
  }

  async #reconcileRecipients(
    github: Pick<ConnectedGitHubAccountClient, 'execute' | 'identity'>,
    configured: GitHubPullRequestRecipient[] | undefined,
    input: IssueDeliveryInput,
    repository: string,
    number: number,
  ): Promise<void> {
    const { assignees: recipients, reviewers } = resolvePullRequestRecipients(
      configured,
      input.item.assignmentActorLogin && input.item.assignmentActorNodeId
        ? { login: input.item.assignmentActorLogin, nodeId: input.item.assignmentActorNodeId }
        : undefined,
    );
    if (recipients.length === 0 && reviewers.length === 0) return;
    const agentNodeId = github.identity.nodeId;
    for (const reviewer of reviewers) {
      if (
        reviewer.nodeId === agentNodeId ||
        reviewer.login.toLowerCase() === github.identity.login.toLowerCase()
      ) {
        throw new Error(`The agent cannot request its own review (${reviewer.login}).`);
      }
    }
    for (const recipient of githubIdentitySet([...recipients, ...reviewers])) {
      const observed = identities(
        await this.#github(
          github,
          ['api', `users/${recipient.login}`, '--jq', '[{login,nodeId:.node_id}]'],
          input.signal,
        ),
        'recipient',
      )[0];
      if (
        !observed ||
        observed.nodeId !== recipient.nodeId ||
        observed.login.toLowerCase() !== recipient.login.toLowerCase()
      ) {
        throw new Error(`The GitHub recipient pin does not match ${recipient.login}.`);
      }
    }
    const issueEndpoint = `repos/${repository}/issues/${number}`;
    const pullEndpoint = `repos/${repository}/pulls/${number}`;
    const current = identities(
      await this.#github(
        github,
        ['api', issueEndpoint, '--jq', '[.assignees[]|{login,nodeId:.node_id}]'],
        input.signal,
      ),
      'pull request assignees',
    );
    const currentLogins = new Set(current.map(({ login }) => login.toLowerCase()));
    const missingAssignees = recipients.filter(
      ({ login }) => !currentLogins.has(login.toLowerCase()),
    );
    for (const recipient of missingAssignees) {
      await this.#githubStatus(
        github,
        ['api', `repos/${repository}/assignees/${recipient.login}`, '--silent'],
        input.signal,
        `assignee eligibility for ${recipient.login}`,
      );
    }
    const pending =
      reviewers.length === 0
        ? new Set<string>()
        : logins(
            await this.#github(
              github,
              ['api', `${pullEndpoint}/requested_reviewers`, '--jq', '[.users[].login]'],
              input.signal,
            ),
            'pending reviewers',
          );
    const completed =
      reviewers.length === 0
        ? new Set<string>()
        : await this.#completedReviewers(github, pullEndpoint, input.signal);
    const missingReviewers = reviewers.filter(
      ({ login }) => !pending.has(login.toLowerCase()) && !completed.has(login.toLowerCase()),
    );
    for (const reviewer of missingReviewers) {
      const permission = record(
        await this.#github(
          github,
          [
            'api',
            `repos/${repository}/collaborators/${reviewer.login}/permission`,
            '--jq',
            '{permission}',
          ],
          input.signal,
        ),
        'reviewer permission',
      ).permission;
      if (!['read', 'triage', 'write', 'maintain', 'admin'].includes(String(permission))) {
        throw new Error(
          `GitHub reviewer ${reviewer.login} is not eligible for pull request ${number}.`,
        );
      }
    }
    if (missingAssignees.length > 0) {
      const updated = logins(
        await this.#github(
          github,
          [
            'api',
            '--method',
            'POST',
            `${issueEndpoint}/assignees`,
            '--input',
            '-',
            '--jq',
            '[.assignees[].login]',
          ],
          input.signal,
          JSON.stringify({ assignees: missingAssignees.map(({ login }) => login) }),
        ),
        'updated assignees',
      );
      for (const { login } of recipients) {
        if (!updated.has(login.toLowerCase()))
          throw new Error(`GitHub did not assign ${login} to pull request ${number}.`);
      }
    }
    if (missingReviewers.length > 0) {
      await this.#github(
        github,
        [
          'api',
          '--method',
          'POST',
          `${pullEndpoint}/requested_reviewers`,
          '--input',
          '-',
          '--jq',
          '[.requested_reviewers[].login]',
        ],
        input.signal,
        JSON.stringify({ reviewers: missingReviewers.map(({ login }) => login) }),
      );
      const requested = logins(
        await this.#github(
          github,
          ['api', `${pullEndpoint}/requested_reviewers`, '--jq', '[.users[].login]'],
          input.signal,
        ),
        'requested reviewers',
      );
      const reviewed = await this.#completedReviewers(github, pullEndpoint, input.signal);
      for (const { login } of missingReviewers) {
        if (!requested.has(login.toLowerCase()) && !reviewed.has(login.toLowerCase()))
          throw new Error(`GitHub did not request review from ${login} on pull request ${number}.`);
      }
    }
  }

  async #completedReviewers(
    github: Pick<ConnectedGitHubAccountClient, 'execute' | 'identity'>,
    pullEndpoint: string,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const pages = await this.#github(
      github,
      ['api', `${pullEndpoint}/reviews`, '--paginate', '--slurp'],
      signal,
    );
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) {
      throw new Error('GitHub returned invalid pull request review pages.');
    }
    const reviewers: string[] = [];
    for (const page of pages) {
      for (const value of page) {
        const review = record(value, 'pull request review');
        const state = requiredString(review.state, 'pull request review state', 32);
        if (state === 'PENDING') continue;
        const user = record(review.user, 'pull request reviewer');
        reviewers.push(requiredString(user.login, 'pull request reviewer login', 100));
      }
    }
    return logins(reviewers, 'completed reviewers');
  }

  async #githubStatus(
    client: Pick<ConnectedGitHubAccountClient, 'execute' | 'identity'>,
    argv: string[],
    signal: AbortSignal | undefined,
    operation: string,
  ): Promise<void> {
    const result = await client.execute(
      argv.includes('--paginate') ? argv : [argv[0]!, '--include', ...argv.slice(1)],
      undefined,
      {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 60_000,
      },
    );
    if (result.exitCode !== 0 || result.timedOut || result.truncated)
      throw new GitHubIssueDeliveryError(
        'github-request',
        `GitHub rejected ${operation}.`,
        githubCliDiagnostic(result),
      );
  }

  async #github(
    client: Pick<ConnectedGitHubAccountClient, 'execute' | 'identity'>,
    argv: string[],
    signal?: AbortSignal,
    stdin?: string,
  ): Promise<unknown> {
    const result = await client.execute(
      argv.includes('--paginate') ? argv : [argv[0]!, '--include', ...argv.slice(1)],
      stdin,
      {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: 60_000,
      },
    );
    if (result.exitCode !== 0 || result.timedOut || result.truncated) {
      throw new GitHubIssueDeliveryError(
        'github-request',
        `GitHub rejected issue delivery reconciliation at ${argv.find((argument) => argument.startsWith('repos/') || argument.startsWith('users/')) ?? 'unknown endpoint'}.`,
        githubCliDiagnostic(result),
      );
    }
    try {
      return JSON.parse(
        result.stdout.startsWith('HTTP/')
          ? parseGitHubApiResponse(result.stdout).body
          : result.stdout,
      );
    } catch {
      throw new GitHubIssueDeliveryError(
        'invalid-response',
        'GitHub returned invalid issue delivery data.',
      );
    }
  }
}
