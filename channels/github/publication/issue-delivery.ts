import providerWriteRejected from '../../../utils/provider-write-rejected.ts';
import GitHubWorkEventApiClient, {
  GitHubWorkEventClientError,
} from '../provider/work-event-api-client.ts';
import {
  withProviderDiagnostic,
  type ProviderDiagnostic,
} from '../../../utils/provider-diagnostic.ts';
import type { GitHubIdentityPin, GitHubPullRequestRecipient } from '../workflow-policy.ts';
import { githubIdentitySet } from '../provider/work-item.ts';
import resolvePullRequestRecipients from '../pull-request-recipients.ts';
import abortableDelay from '../../../utils/abortable-delay.ts';
import type { ConnectedGitHubAccountClient } from '../../../core/github-account-client.ts';

export interface GitHubNotificationIssueDeliveryReceipt {
  pullRequestNodeId: string;
  pullRequestNumber: number;
}

export interface AdoptedPullRequest extends GitHubNotificationIssueDeliveryReceipt {
  branch: string;
  base: string;
  head: string;
  authorId: string;
  title: string;
  body: string;
}

export type GitHubIssueDeliveryFailureCategory =
  'github-request' | 'invalid-response' | 'identity-mismatch';

export class GitHubIssueDeliveryError extends Error {
  override name = 'GitHubIssueDeliveryError';

  constructor(
    readonly category: GitHubIssueDeliveryFailureCategory,
    message: string,
    readonly providerDiagnostic?: ProviderDiagnostic,
    readonly code = `github-delivery-${category}`,
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
  adopted?: Pick<AdoptedPullRequest, 'authorId' | 'base'>;
  headSha?: string;
  previousHeadSha?: string;
  repositoryNodeId?: string;
  linkIssue?: boolean;
  contentUpdate?: { title?: string; body?: string };
  beforeCreate?: () => Promise<void>;
  onCreateRejected?: () => Promise<void>;
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
    readonly client: Pick<
      ConnectedGitHubAccountClient,
      'execute' | 'identity' | 'observationScope' | 'credentialFingerprint'
    >,
    private readonly delay = abortableDelay,
  ) {}
  /** explicit selection observes existing work; it is not a publication receipt. */
  async adopt(
    input: Pick<IssueDeliveryInput, 'item' | 'repositoryNodeId' | 'signal'>,
    target: string,
  ): Promise<AdoptedPullRequest> {
    const repository = `${input.item.repositoryOwner}/${input.item.repositoryName}`;
    const reference = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)\/?$/iu.exec(
      target,
    );
    if (!reference || reference[1]!.toLowerCase() !== repository.toLowerCase())
      throw new Error('delivery-adoption-target-invalid');
    const number = positiveInteger(Number(reference[2]), 'pull request number');
    const observed = record(
      await this.#github(
        this.client,
        [
          'api',
          `repos/${repository}/pulls/${number}`,
          '--jq',
          '{nodeId:.node_id,number,state,repositoryId:.base.repo.node_id,headRepositoryId:.head.repo.node_id,head:.head.sha,branch:.head.ref,base:.base.ref,authorId:.user.node_id,title,body}',
        ],
        input.signal,
      ),
      'pull request adoption',
    );
    if (
      !input.repositoryNodeId ||
      observed.repositoryId !== input.repositoryNodeId ||
      observed.headRepositoryId !== input.repositoryNodeId ||
      observed.state !== 'open' ||
      observed.number !== number
    )
      throw new Error('delivery-adoption-identity-mismatch');
    const head = requiredString(observed.head, 'pull request head', 64);
    if (!/^[a-f0-9]{40,64}$/u.test(head)) throw new Error('delivery-adoption-head-invalid');
    parseIssue(
      await this.#github(
        this.client,
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
    return {
      pullRequestNodeId: requiredString(observed.nodeId, 'pull request node id', 255),
      pullRequestNumber: number,
      branch: requiredString(observed.branch, 'pull request branch', 255),
      base: requiredString(observed.base, 'pull request base', 255),
      head,
      authorId: requiredString(observed.authorId, 'pull request author', 255),
      title: requiredString(observed.title, 'pull request title', 512),
      body: boundedString(observed.body ?? '', 'pull request body', 65536),
    };
  }
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
    if (!input.adopted && !(await this.#linkedIssue(input, pullRequest)))
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
      const delays = [250, 500, 1000];
      for (let attempt = 0; ; attempt++) {
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
        const expected = {
          nodeId: pullRequest.itemNodeId,
          repositoryId: input.repositoryNodeId,
          headRepositoryId: input.repositoryNodeId,
          authorId: input.adopted?.authorId ?? github.identity.nodeId,
          baseRef: input.adopted?.base ?? input.item.repositoryDefaultBranch,
          headRef: branch,
          state: 'open',
          number: pullRequest.number,
        };
        for (const [field, value] of Object.entries(expected))
          if (observed[field] !== value)
            throw new GitHubIssueDeliveryError(
              'identity-mismatch',
              'The pull request binding changed.',
              undefined,
              `github-delivery-binding-${field.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}-changed`,
            );
        if (observed.headSha === input.headSha) break;
        const pending =
          Boolean(input.previousHeadSha) && observed.headSha === input.previousHeadSha;
        if (!pending || attempt === delays.length)
          throw new GitHubIssueDeliveryError(
            'identity-mismatch',
            'The pull request head does not match the verified push.',
            undefined,
            pending ? 'github-delivery-head-not-observed' : 'github-delivery-binding-head-changed',
          );
        await this.delay(delays[attempt]!, input.signal);
      }
    }
    if (
      !normalize &&
      pullRequest.baseRef !== (input.adopted?.base ?? input.item.repositoryDefaultBranch)
    ) {
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
      if (authorNodeId !== (input.adopted?.authorId ?? github.identity.nodeId)) {
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
          ).catch(async (error: unknown) => {
            if (providerWriteRejected(error)) await input.onCreateRejected?.();
            throw error;
          }),
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
    github: Pick<
      ConnectedGitHubAccountClient,
      'execute' | 'identity' | 'observationScope' | 'credentialFingerprint'
    >,
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
    github: Pick<
      ConnectedGitHubAccountClient,
      'execute' | 'identity' | 'observationScope' | 'credentialFingerprint'
    >,
    pullEndpoint: string,
    signal?: AbortSignal,
  ): Promise<Set<string>> {
    const reviewers: string[] = [];
    for (let page = 1; ; page++) {
      const response = await this.#request(
        github,
        [
          'api',
          '--method',
          'GET',
          `${pullEndpoint}/reviews`,
          '-F',
          'per_page=100',
          '-F',
          `page=${page}`,
          '--jq',
          '[.[]|{state,user:{login:.user.login}}]',
        ],
        signal,
      );
      if (!Array.isArray(response.value))
        throw new Error('GitHub returned invalid pull request reviews.');
      for (const value of response.value) {
        const review = record(value, 'pull request review');
        const state = requiredString(review.state, 'pull request review state', 32);
        if (state === 'PENDING') continue;
        const user = record(review.user, 'pull request reviewer');
        reviewers.push(requiredString(user.login, 'pull request reviewer login', 100));
      }
      if (!response.hasNextPage) break;
    }
    return logins(reviewers, 'completed reviewers');
  }

  async #github(
    client: Pick<
      ConnectedGitHubAccountClient,
      'execute' | 'identity' | 'observationScope' | 'credentialFingerprint'
    >,
    argv: string[],
    signal?: AbortSignal,
    stdin?: string,
  ): Promise<unknown> {
    return (await this.#request(client, argv, signal, stdin)).value;
  }

  async #request(client: typeof this.client, argv: string[], signal?: AbortSignal, stdin?: string) {
    let executionFailure: unknown;
    try {
      return await new GitHubWorkEventApiClient({
        identity: client.identity,
        credentialFingerprint: client.credentialFingerprint,
        observationScope: client.observationScope ?? client,
        async execute(...args) {
          try {
            return await client.execute(...args);
          } catch (error) {
            executionFailure = error;
            throw error;
          }
        },
      }).request(argv.slice(1), 'issue delivery', stdin, { signal, timeoutMs: 60_000 });
    } catch (error) {
      // preserve delivery's transport exceptions and uncertain-write recovery contract.
      if (executionFailure) throw executionFailure;
      throw new GitHubIssueDeliveryError(
        error instanceof GitHubWorkEventClientError &&
          error.code === 'github-notification-response-invalid'
          ? 'invalid-response'
          : 'github-request',
        'GitHub could not reconcile issue delivery.',
        error instanceof GitHubWorkEventClientError ? error.providerDiagnostic : undefined,
      );
    }
  }
}
