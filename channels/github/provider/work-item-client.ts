import {
  githubResponseBoolean,
  githubResponseGitRef,
  githubResponseGitSha,
  githubResponseHasControlCharacter,
  githubResponseIdentity,
  githubResponseInteger,
  githubResponseNodeId,
  githubResponseOptionalIdentity,
  githubResponseOptionalRepositoryReference,
  githubResponsePositiveInteger,
  githubResponseRecord,
  githubResponseRepositoryReference,
  githubResponseString,
  githubResponseTimestamp,
} from './work-event-normalization.ts';
import {
  githubRepositoryEndpoint,
  githubWorkItemEndpoint,
  type default as GitHubWorkEventApiClient,
} from './work-event-api-client.ts';
import type {
  GitHubAssignedItemDiscovery,
  GitHubNotificationIntakeClient,
} from './work-event-types.ts';
import {
  githubRepositoryPath,
  type GitHubAssignedItemCandidate,
  type GitHubAssignmentEvent,
  type GitHubCanonicalWorkItem,
  type GitHubIdentity,
  type GitHubRepositoryIdentity,
  type GitHubRepositoryPermission,
} from './work-item.ts';

const pageSize = 100;
const maximumSearchPages = 10;
const maximumEventPages = 3;

/** Read bounded assignment, repository, and work-item control facts from GitHub. */
export default class GitHubWorkItemClient implements GitHubNotificationIntakeClient {
  readonly #api: GitHubWorkEventApiClient;

  constructor(api: GitHubWorkEventApiClient) {
    this.#api = api;
  }

  get identity(): GitHubIdentity {
    return this.#api.identity;
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
      const response = await this.#api.request(
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
      const body = githubResponseRecord(response.value, 'assigned-item search');
      totalCount = githubResponseInteger(body.totalCount, 'assigned-item total count');
      incomplete ||= githubResponseBoolean(body.incomplete, 'assigned-item incomplete flag');
      if (!Array.isArray(body.items)) throw new Error('GitHub returned invalid assigned items.');
      for (const value of body.items) {
        const item = githubResponseRecord(value, 'assigned item');
        const repositoryPath = githubResponseString(
          item.repositoryPath,
          'assigned-item repository path',
        );
        githubRepositoryPath(repositoryPath);
        candidates.push({
          databaseId: githubResponsePositiveInteger(item.databaseId, 'assigned-item database id'),
          itemType: githubResponseBoolean(item.isPullRequest, 'assigned-item type')
            ? 'pull-request'
            : 'issue',
          nodeId: githubResponseNodeId(item.nodeId, 'assigned-item node id'),
          number: githubResponsePositiveInteger(item.number, 'assigned-item number'),
          repositoryPath,
          updatedAt: githubResponseTimestamp(item.updatedAt, 'assigned-item update time'),
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
    const response = await this.#api.request(
      [
        githubRepositoryEndpoint(owner, name),
        '--jq',
        '{databaseId:.id,nodeId:.node_id,name,owner:{login:.owner.login,nodeId:.owner.node_id,type:.owner.type},cloneUrl:.clone_url,defaultBranch:.default_branch,archived,disabled}',
      ],
      'repository',
    );
    const value = githubResponseRecord(response.value, 'repository');
    const repository = {
      archived: githubResponseBoolean(value.archived, 'repository archived flag'),
      cloneUrl: githubResponseString(value.cloneUrl, 'repository clone url'),
      databaseId: githubResponsePositiveInteger(value.databaseId, 'repository database id'),
      defaultBranch: githubResponseString(value.defaultBranch, 'repository default branch'),
      disabled: githubResponseBoolean(value.disabled, 'repository disabled flag'),
      name: githubResponseString(value.name, 'repository name'),
      nodeId: githubResponseNodeId(value.nodeId, 'repository node id'),
      owner: githubResponseIdentity(value.owner, 'repository owner'),
    };
    const expectedCloneUrl = `https://github.com/${repository.owner.login}/${repository.name}.git`;
    if (repository.cloneUrl.toLowerCase() !== expectedCloneUrl.toLowerCase()) {
      throw new Error('GitHub returned an unsupported repository clone URL.');
    }
    if (
      repository.defaultBranch.length > 255 ||
      githubResponseHasControlCharacter(repository.defaultBranch)
    ) {
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
    const response = await this.#api.request(
      [
        `${githubRepositoryEndpoint(owner, name)}/collaborators/${login}/permission`,
        '--jq',
        '{permission}',
      ],
      'repository permission',
    );
    const permission = githubResponseString(
      githubResponseRecord(response.value, 'repository permission').permission,
      'repository permission',
    );
    if (!['admin', 'maintain', 'none', 'read', 'triage', 'write'].includes(permission)) {
      throw new Error('GitHub returned an unsupported repository permission.');
    }
    return permission as GitHubRepositoryPermission;
  }

  async getItem(owner: string, name: string, number: number): Promise<GitHubCanonicalWorkItem> {
    const endpoint = githubWorkItemEndpoint(owner, name, number);
    const response = await this.#api.request(
      [
        endpoint,
        '--jq',
        '{databaseId:.id,nodeId:.node_id,number,state,updatedAt:.updated_at,title,isPullRequest:(.pull_request!=null),assignees:[.assignees[]|{login,nodeId:.node_id,type}]}',
      ],
      'work item',
    );
    const value = githubResponseRecord(response.value, 'work item');
    const state = githubResponseString(value.state, 'work-item state');
    if (state !== 'open' && state !== 'closed') {
      throw new Error('GitHub returned an unsupported work-item state.');
    }
    if (!Array.isArray(value.assignees)) throw new Error('GitHub returned invalid assignees.');
    const item = {
      assignees: value.assignees.map((item) => githubResponseIdentity(item, 'assignee')),
      databaseId: githubResponsePositiveInteger(value.databaseId, 'work-item database id'),
      nodeId: githubResponseNodeId(value.nodeId, 'work-item node id'),
      number: githubResponsePositiveInteger(value.number, 'work-item number'),
      state: state as 'closed' | 'open',
      updatedAt: githubResponseTimestamp(value.updatedAt, 'work-item update time'),
    };
    if (!githubResponseBoolean(value.isPullRequest, 'work-item type')) {
      if (typeof value.title !== 'string')
        throw new Error('GitHub returned an invalid issue title.');
      return { ...item, itemType: 'issue', title: value.title };
    }

    const pullResponse = await this.#api.request(
      [
        `${githubRepositoryEndpoint(owner, name)}/pulls/${number}`,
        '--jq',
        '{author:(if .user==null then null else {login:.user.login,nodeId:.user.node_id,type:.user.type} end),base:{ref:.base.ref,repository:{databaseId:.base.repo.id,nodeId:.base.repo.node_id}},draft,head:{ref:.head.ref,sha:.head.sha,repository:(if .head.repo==null then null else {databaseId:.head.repo.id,nodeId:.head.repo.node_id} end)},merged}',
      ],
      'pull request',
    );
    const pull = githubResponseRecord(pullResponse.value, 'pull request');
    const base = githubResponseRecord(pull.base, 'pull-request base');
    const head = githubResponseRecord(pull.head, 'pull-request head');
    const baseRepository = githubResponseRepositoryReference(
      base.repository,
      'pull-request base repository',
    );
    const headRepository = githubResponseOptionalRepositoryReference(
      head.repository,
      'pull-request head repository',
    );
    return {
      ...item,
      itemType: 'pull-request',
      pullRequest: {
        author: githubResponseOptionalIdentity(pull.author, 'pull-request author'),
        baseRef: githubResponseGitRef(base.ref, 'pull-request base ref'),
        baseRepositoryDatabaseId: baseRepository.databaseId,
        baseRepositoryNodeId: baseRepository.nodeId,
        draft: githubResponseBoolean(pull.draft, 'pull-request draft flag'),
        headRef: githubResponseGitRef(head.ref, 'pull-request head ref'),
        ...(headRepository === undefined
          ? {}
          : {
              headRepositoryDatabaseId: headRepository.databaseId,
              headRepositoryNodeId: headRepository.nodeId,
            }),
        headSha: githubResponseGitSha(head.sha, 'pull-request head sha'),
        merged: githubResponseBoolean(pull.merged, 'pull-request merged flag'),
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
      const response = await this.#api.request(
        [
          '--method',
          'GET',
          `${githubWorkItemEndpoint(owner, name, number)}/events`,
          '-F',
          `per_page=${pageSize}`,
          '-F',
          `page=${page}`,
          '--jq',
          '[.[]|select(.event=="assigned" or .event=="unassigned")|{databaseId:.id,nodeId:.node_id,event,createdAt:.created_at,actor:{login:.assigner.login,nodeId:.assigner.node_id,type:.assigner.type},assignee:{login:.assignee.login,nodeId:.assignee.node_id,type:.assignee.type}}]',
        ],
        'assignment events',
      );
      if (!Array.isArray(response.value)) {
        throw new Error('GitHub returned invalid assignment events.');
      }
      for (const item of response.value) {
        const value = githubResponseRecord(item, 'assignment event');
        const event = githubResponseString(value.event, 'assignment event kind');
        if (event !== 'assigned' && event !== 'unassigned') continue;
        events.push({
          actor: githubResponseIdentity(value.actor, 'assignment actor'),
          assignee: githubResponseIdentity(value.assignee, 'assignment assignee'),
          createdAt: githubResponseTimestamp(value.createdAt, 'assignment event time'),
          databaseId: githubResponsePositiveInteger(
            value.databaseId,
            'assignment event database id',
          ),
          event,
          nodeId: githubResponseNodeId(value.nodeId, 'assignment event node id'),
        });
      }
      hasNextPage = response.hasNextPage;
      if (!hasNextPage) break;
    }
    return { events, truncated: hasNextPage };
  }
}
