import type { ConnectedGitHubAccountClient } from '../../../lib/github-account-client.ts';
import { parseGitHubApiResponse, type GitHubRateLimit } from '../utils/api-response.ts';
import {
  githubRepositoryPath,
  type GitHubAssignedItemCandidate,
  type GitHubAssignmentEvent,
  type GitHubCanonicalWorkItem,
  type GitHubIdentity,
  type GitHubRepositoryIdentity,
  type GitHubRepositoryPermission,
} from '../utils/work-item.ts';

const pageSize = 100;
const maximumSearchPages = 10;
const maximumEventPages = 3;

export class GitHubWorkEventClientError extends Error {
  override name = 'GitHubWorkEventClientError';

  constructor(
    readonly code: string,
    message: string,
    readonly rateLimit: GitHubRateLimit = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface GitHubAssignedItemDiscovery {
  candidates: GitHubAssignedItemCandidate[];
  incomplete: boolean;
  totalCount: number;
  truncated: boolean;
}

interface ApiPage<T> {
  hasNextPage: boolean;
  value: T;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GitHub returned invalid ${label} data.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`GitHub returned invalid ${label}.`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = integer(value, label);
  if (parsed < 1) throw new Error(`GitHub returned invalid ${label}.`);
  return parsed;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`GitHub returned invalid ${label}.`);
  return value;
}

function nodeId(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (parsed.length > 255 || parsed.includes('\0') || /\s/u.test(parsed)) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return parsed;
}

function timestamp(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`GitHub returned invalid ${label}.`);
  return parsed;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function identity(value: unknown, label: string): GitHubIdentity {
  const item = record(value, label);
  const login = string(item.login, `${label} login`);
  const identityNodeId = nodeId(item.nodeId, `${label} node id`);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(login)) {
    throw new Error(`GitHub returned invalid ${label} login.`);
  }
  return {
    login,
    nodeId: identityNodeId,
    type: string(item.type, `${label} type`),
  };
}

function optionalIdentity(value: unknown, label: string): GitHubIdentity | undefined {
  return value === null || value === undefined ? undefined : identity(value, label);
}

function gitRef(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (parsed.length > 255 || hasControlCharacter(parsed)) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return parsed;
}

function gitSha(value: unknown, label: string): string {
  const parsed = string(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(parsed)) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return parsed;
}

function repositoryReference(
  value: unknown,
  label: string,
): { databaseId: number; nodeId: string } {
  const repository = record(value, label);
  return {
    databaseId: positiveInteger(repository.databaseId, `${label} database id`),
    nodeId: nodeId(repository.nodeId, `${label} node id`),
  };
}

function optionalRepositoryReference(
  value: unknown,
  label: string,
): { databaseId: number; nodeId: string } | undefined {
  return value === null || value === undefined ? undefined : repositoryReference(value, label);
}

function repositoryEndpoint(owner: string, name: string): string {
  const segment = /^[A-Za-z0-9_.-]+$/u;
  if (!segment.test(owner) || !segment.test(name)) {
    throw new Error('GitHub repository coordinates are invalid.');
  }
  return `/repos/${owner}/${name}`;
}

/** Fixed-endpoint, bounded GitHub REST access for assignment control facts. */
export default class GitHubWorkEventClient {
  readonly #client: ConnectedGitHubAccountClient;
  #rateLimit: GitHubRateLimit = {};

  constructor(client: ConnectedGitHubAccountClient) {
    this.#client = client;
  }

  get identity(): GitHubIdentity {
    return { ...this.#client.identity, type: 'User' };
  }

  get rateLimit(): GitHubRateLimit {
    return { ...this.#rateLimit };
  }

  async discoverAssigned(
    updatedSince: string,
    assignmentTypes: readonly ('issue' | 'pull-request')[],
  ): Promise<GitHubAssignedItemDiscovery> {
    const candidates: GitHubAssignedItemCandidate[] = [];
    let incomplete = false;
    let totalCount = 0;
    let hasNextPage = false;
    for (let page = 1; page <= maximumSearchPages; page += 1) {
      const response = await this.#api(
        [
          '--method',
          'GET',
          '/search/issues',
          '-f',
          `q=assignee:${this.identity.login} state:open updated:>=${updatedSince}${
            assignmentTypes.length === 1
              ? assignmentTypes[0] === 'issue'
                ? ' is:issue'
                : ' is:pr'
              : ''
          }`,
          '-F',
          `per_page=${pageSize}`,
          '-F',
          `page=${page}`,
          '-f',
          'sort=updated',
          '-f',
          'order=asc',
          '--jq',
          '{totalCount:.total_count,incomplete:.incomplete_results,items:[.items[]|{databaseId:.id,nodeId:.node_id,number,repositoryPath:.repository_url,updatedAt:.updated_at,isPullRequest:(.pull_request!=null)}]}',
        ],
        'assigned-item search',
      );
      const body = record(response.value, 'assigned-item search');
      totalCount = integer(body.totalCount, 'assigned-item total count');
      incomplete ||= boolean(body.incomplete, 'assigned-item incomplete flag');
      if (!Array.isArray(body.items)) throw new Error('GitHub returned invalid assigned items.');
      for (const value of body.items) {
        const item = record(value, 'assigned item');
        const repositoryPath = string(item.repositoryPath, 'assigned-item repository path');
        githubRepositoryPath(repositoryPath);
        candidates.push({
          databaseId: positiveInteger(item.databaseId, 'assigned-item database id'),
          itemType: boolean(item.isPullRequest, 'assigned-item type') ? 'pull-request' : 'issue',
          nodeId: nodeId(item.nodeId, 'assigned-item node id'),
          number: positiveInteger(item.number, 'assigned-item number'),
          repositoryPath,
          updatedAt: timestamp(item.updatedAt, 'assigned-item update time'),
        });
      }
      hasNextPage = response.hasNextPage;
      if (!hasNextPage) break;
    }
    return {
      candidates,
      incomplete,
      totalCount,
      truncated: incomplete || hasNextPage || totalCount > candidates.length,
    };
  }

  async getRepository(owner: string, name: string): Promise<GitHubRepositoryIdentity> {
    const response = await this.#api(
      [
        repositoryEndpoint(owner, name),
        '--jq',
        '{databaseId:.id,nodeId:.node_id,name,owner:{login:.owner.login,nodeId:.owner.node_id,type:.owner.type},cloneUrl:.clone_url,defaultBranch:.default_branch,archived,disabled}',
      ],
      'repository',
    );
    const value = record(response.value, 'repository');
    const repository = {
      archived: boolean(value.archived, 'repository archived flag'),
      cloneUrl: string(value.cloneUrl, 'repository clone url'),
      databaseId: positiveInteger(value.databaseId, 'repository database id'),
      defaultBranch: string(value.defaultBranch, 'repository default branch'),
      disabled: boolean(value.disabled, 'repository disabled flag'),
      name: string(value.name, 'repository name'),
      nodeId: nodeId(value.nodeId, 'repository node id'),
      owner: identity(value.owner, 'repository owner'),
    };
    const expectedCloneUrl = `https://github.com/${repository.owner.login}/${repository.name}.git`;
    if (repository.cloneUrl.toLowerCase() !== expectedCloneUrl.toLowerCase()) {
      throw new Error('GitHub returned an unsupported repository clone URL.');
    }
    if (repository.defaultBranch.length > 255 || hasControlCharacter(repository.defaultBranch)) {
      throw new Error('GitHub returned an unsupported default branch.');
    }
    return repository;
  }

  async getPermission(
    owner: string,
    name: string,
    login: string,
  ): Promise<GitHubRepositoryPermission> {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(login)) {
      throw new Error('GitHub account login is invalid.');
    }
    const response = await this.#api(
      [
        `${repositoryEndpoint(owner, name)}/collaborators/${login}/permission`,
        '--jq',
        '{permission}',
      ],
      'repository permission',
    );
    const permission = string(
      record(response.value, 'repository permission').permission,
      'repository permission',
    );
    if (!['admin', 'maintain', 'none', 'read', 'triage', 'write'].includes(permission)) {
      throw new Error('GitHub returned an unsupported repository permission.');
    }
    return permission as GitHubRepositoryPermission;
  }

  async getItem(owner: string, name: string, number: number): Promise<GitHubCanonicalWorkItem> {
    const endpoint = this.#itemEndpoint(owner, name, number);
    const response = await this.#api(
      [
        endpoint,
        '--jq',
        '{databaseId:.id,nodeId:.node_id,number,state,updatedAt:.updated_at,isPullRequest:(.pull_request!=null),assignees:[.assignees[]|{login,nodeId:.node_id,type}]}',
      ],
      'work item',
    );
    const value = record(response.value, 'work item');
    const state = string(value.state, 'work-item state');
    if (state !== 'open' && state !== 'closed') {
      throw new Error('GitHub returned an unsupported work-item state.');
    }
    if (!Array.isArray(value.assignees)) throw new Error('GitHub returned invalid assignees.');
    const item = {
      assignees: value.assignees.map((item) => identity(item, 'assignee')),
      databaseId: positiveInteger(value.databaseId, 'work-item database id'),
      nodeId: nodeId(value.nodeId, 'work-item node id'),
      number: positiveInteger(value.number, 'work-item number'),
      state: state as 'closed' | 'open',
      updatedAt: timestamp(value.updatedAt, 'work-item update time'),
    };
    if (!boolean(value.isPullRequest, 'work-item type')) {
      return { ...item, itemType: 'issue' };
    }

    const pullResponse = await this.#api(
      [
        `${repositoryEndpoint(owner, name)}/pulls/${number}`,
        '--jq',
        '{author:(if .user==null then null else {login:.user.login,nodeId:.user.node_id,type:.user.type} end),base:{ref:.base.ref,repository:{databaseId:.base.repo.id,nodeId:.base.repo.node_id}},draft,head:{ref:.head.ref,sha:.head.sha,repository:(if .head.repo==null then null else {databaseId:.head.repo.id,nodeId:.head.repo.node_id} end)},merged}',
      ],
      'pull request',
    );
    const pull = record(pullResponse.value, 'pull request');
    const base = record(pull.base, 'pull-request base');
    const head = record(pull.head, 'pull-request head');
    const baseRepository = repositoryReference(base.repository, 'pull-request base repository');
    const headRepository = optionalRepositoryReference(
      head.repository,
      'pull-request head repository',
    );
    return {
      ...item,
      itemType: 'pull-request',
      pullRequest: {
        author: optionalIdentity(pull.author, 'pull-request author'),
        baseRef: gitRef(base.ref, 'pull-request base ref'),
        baseRepositoryDatabaseId: baseRepository.databaseId,
        baseRepositoryNodeId: baseRepository.nodeId,
        draft: boolean(pull.draft, 'pull-request draft flag'),
        headRef: gitRef(head.ref, 'pull-request head ref'),
        ...(headRepository === undefined
          ? {}
          : {
              headRepositoryDatabaseId: headRepository.databaseId,
              headRepositoryNodeId: headRepository.nodeId,
            }),
        headSha: gitSha(head.sha, 'pull-request head sha'),
        merged: boolean(pull.merged, 'pull-request merged flag'),
      },
    };
  }

  async listAssignmentEvents(
    owner: string,
    name: string,
    number: number,
  ): Promise<{ events: GitHubAssignmentEvent[]; truncated: boolean }> {
    const events: GitHubAssignmentEvent[] = [];
    let hasNextPage = false;
    for (let page = 1; page <= maximumEventPages; page += 1) {
      const response = await this.#api(
        [
          '--method',
          'GET',
          `${this.#itemEndpoint(owner, name, number)}/events`,
          '-F',
          `per_page=${pageSize}`,
          '-F',
          `page=${page}`,
          '--jq',
          '[.[]|select(.event=="assigned" or .event=="unassigned")|{databaseId:.id,nodeId:.node_id,event,createdAt:.created_at,actor:{login:.assigner.login,nodeId:.assigner.node_id,type:.assigner.type},assignee:{login:.assignee.login,nodeId:.assignee.node_id,type:.assignee.type}}]',
        ],
        'assignment events',
      );
      if (!Array.isArray(response.value))
        throw new Error('GitHub returned invalid assignment events.');
      for (const item of response.value) {
        const value = record(item, 'assignment event');
        const event = string(value.event, 'assignment event kind');
        if (event !== 'assigned' && event !== 'unassigned') continue;
        events.push({
          actor: identity(value.actor, 'assignment actor'),
          assignee: identity(value.assignee, 'assignment assignee'),
          createdAt: timestamp(value.createdAt, 'assignment event time'),
          databaseId: positiveInteger(value.databaseId, 'assignment event database id'),
          event,
          nodeId: nodeId(value.nodeId, 'assignment event node id'),
        });
      }
      hasNextPage = response.hasNextPage;
      if (!hasNextPage) break;
    }
    return { events, truncated: hasNextPage };
  }

  #itemEndpoint(owner: string, name: string, number: number): string {
    if (!Number.isSafeInteger(number) || number < 1) {
      throw new Error('GitHub work-item numbers must be positive safe integers.');
    }
    return `${repositoryEndpoint(owner, name)}/issues/${number}`;
  }

  async #api(argv: string[], label: string, stdin?: string): Promise<ApiPage<unknown>> {
    const result = await this.#client.execute(['api', '--include', ...argv], stdin, {
      maxOutputBytes: 512 * 1024,
      timeoutMs: 30_000,
    });
    let response;
    try {
      response = parseGitHubApiResponse(result.stdout);
      this.#rateLimit = response.rateLimit;
    } catch (error) {
      throw new GitHubWorkEventClientError(
        'github-notification-response-invalid',
        `GitHub returned an invalid ${label} response.`,
        {},
        { cause: error },
      );
    }
    if (result.timedOut || result.truncated) {
      throw new GitHubWorkEventClientError(
        'github-notification-response-bounded',
        `The GitHub ${label} response exceeded its runtime boundary.`,
        response.rateLimit,
      );
    }
    if (result.exitCode !== 0 || response.status < 200 || response.status >= 300) {
      throw new GitHubWorkEventClientError(
        response.status === 404
          ? 'github-notification-resource-missing'
          : 'github-notification-request-failed',
        `GitHub could not provide ${label} control facts.`,
        response.rateLimit,
      );
    }
    try {
      return { hasNextPage: response.hasNextPage, value: JSON.parse(response.body) as unknown };
    } catch (error) {
      throw new GitHubWorkEventClientError(
        'github-notification-response-invalid',
        `GitHub returned invalid ${label} data.`,
        response.rateLimit,
        { cause: error },
      );
    }
  }
}
