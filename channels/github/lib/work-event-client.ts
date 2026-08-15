import type { ConnectedGitHubAccountClient } from '../../../lib/github-account-client.ts';
import { parseGitHubApiResponse, type GitHubRateLimit } from '../utils/api-response.ts';
import type { GitHubCanonicalIssueComment } from '../utils/comment-admission.ts';
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
const maximumCommentPages = 10;
const maximumCommentBodyLength = 1_000;
const maximumTrackedCommentPages = 3;
const maximumPlanningComments = 50;
const maximumPlanningFiles = 100;

export interface GitHubNotificationPlanningComment {
  authorLogin: string;
  body: string;
  createdAt: string;
}

export interface GitHubNotificationPlanningContext {
  body: string;
  comments: GitHubNotificationPlanningComment[];
  files?: GitHubNotificationPlanningFile[];
  labels: string[];
  title: string;
  truncated: boolean;
}

export interface GitHubNotificationPlanningFile {
  additions: number;
  changes: number;
  deletions: number;
  filename: string;
  previousFilename?: string;
  status: string;
}

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

export interface GitHubIssueCommentReceipt {
  databaseId: number;
  nodeId: string;
}

export interface GitHubIssueCommentPage {
  comments: GitHubCanonicalIssueComment[];
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

function boundedProse(
  value: unknown,
  label: string,
  maximumLength: number,
): { text: string; truncated: boolean } {
  if (value === null) return { text: '', truncated: false };
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return {
    text: value.slice(0, maximumLength),
    truncated: value.length > maximumLength,
  };
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

function issueComment(value: unknown): GitHubCanonicalIssueComment {
  const item = record(value, 'issue comment');
  const body = boundedProse(item.body, 'issue-comment body', maximumCommentBodyLength);
  const bodyLength = integer(item.bodyLength, 'issue-comment body length');
  return {
    author: optionalIdentity(item.author, 'issue-comment author'),
    body: body.text,
    bodyTruncated: body.truncated || bodyLength > maximumCommentBodyLength,
    createdAt: timestamp(item.createdAt, 'issue-comment creation time'),
    databaseId: positiveInteger(item.databaseId, 'issue-comment database id'),
    nodeId: nodeId(item.nodeId, 'issue-comment node id'),
    updatedAt: timestamp(item.updatedAt, 'issue-comment update time'),
  };
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

  /** Fetch a bounded, prose-only projection for the private planning turn. */
  async getPlanningContext(
    owner: string,
    name: string,
    number: number,
    itemType: 'issue' | 'pull-request' = 'issue',
  ): Promise<GitHubNotificationPlanningContext> {
    const endpoint = this.#itemEndpoint(owner, name, number);
    const response = await this.#api(
      [
        endpoint,
        '--jq',
        '{title,body,commentCount:.comments,labels:[.labels[]|(if type=="string" then . else .name end)]}',
      ],
      'planning context',
    );
    const value = record(response.value, 'planning context');
    const title = boundedProse(value.title, 'planning-context title', 512);
    if (!title.text.trim()) throw new Error('GitHub returned an invalid planning-context title.');
    const body = boundedProse(value.body, 'planning-context body', 24_000);
    const commentCount = integer(value.commentCount, 'planning-context comment count');
    if (!Array.isArray(value.labels)) throw new Error('GitHub returned invalid issue labels.');
    const labels = value.labels.slice(0, 100).map((label) => {
      const parsed = string(label, 'issue label');
      if (parsed.length > 100 || hasControlCharacter(parsed)) {
        throw new Error('GitHub returned an invalid issue label.');
      }
      return parsed;
    });
    const comments: GitHubNotificationPlanningComment[] = [];
    let commentsTruncated = commentCount > maximumPlanningComments;
    if (commentCount > 0) {
      const commentValues: unknown[] = [];
      const firstPage = Math.max(1, Math.ceil(commentCount / maximumPlanningComments) - 1);
      let page = firstPage;
      let hasNextPage: boolean;
      do {
        const commentsResponse = await this.#api(
          [
            '--method',
            'GET',
            `${endpoint}/comments`,
            '-F',
            `per_page=${maximumPlanningComments}`,
            '-F',
            `page=${page}`,
            '--jq',
            '[.[]|{authorLogin:(.user.login//"unknown"),body,createdAt:.created_at}]',
          ],
          'planning comments',
        );
        if (!Array.isArray(commentsResponse.value)) {
          throw new Error('GitHub returned invalid planning comments.');
        }
        commentValues.push(...commentsResponse.value);
        hasNextPage = commentsResponse.hasNextPage;
        page += 1;
      } while (hasNextPage && page < firstPage + 2);
      commentsTruncated ||= firstPage > 1 || hasNextPage || commentValues.length > 50;
      for (const item of commentValues.slice(-maximumPlanningComments)) {
        const comment = record(item, 'planning comment');
        const authorLogin = boundedProse(comment.authorLogin, 'planning-comment author', 100);
        if (!authorLogin.text) {
          throw new Error('GitHub returned an invalid planning-comment author.');
        }
        const commentBody = boundedProse(comment.body, 'planning-comment body', 2_000);
        commentsTruncated ||= authorLogin.truncated || commentBody.truncated;
        comments.push({
          authorLogin: authorLogin.text,
          body: commentBody.text,
          createdAt: timestamp(comment.createdAt, 'planning-comment time'),
        });
      }
    }
    const files: GitHubNotificationPlanningFile[] = [];
    let filesTruncated = false;
    if (itemType === 'pull-request') {
      const filesResponse = await this.#api(
        [
          '--method',
          'GET',
          `${repositoryEndpoint(owner, name)}/pulls/${number}/files`,
          '-F',
          `per_page=${maximumPlanningFiles}`,
          '-F',
          'page=1',
          '--jq',
          '[.[]|{additions,changes,deletions,filename,previousFilename:.previous_filename,status}]',
        ],
        'pull-request files',
      );
      if (!Array.isArray(filesResponse.value)) {
        throw new Error('GitHub returned invalid pull-request files.');
      }
      filesTruncated = filesResponse.hasNextPage;
      for (const entry of filesResponse.value.slice(0, maximumPlanningFiles)) {
        const file = record(entry, 'pull-request file');
        const filename = boundedProse(file.filename, 'pull-request filename', 1_024);
        const previousFilename =
          file.previousFilename === null || file.previousFilename === undefined
            ? undefined
            : boundedProse(file.previousFilename, 'pull-request previous filename', 1_024);
        const status = boundedProse(file.status, 'pull-request file status', 32);
        if (!filename.text || !status.text) {
          throw new Error('GitHub returned an invalid pull-request file.');
        }
        filesTruncated ||=
          filename.truncated || previousFilename?.truncated === true || status.truncated;
        files.push({
          additions: integer(file.additions, 'pull-request file additions'),
          changes: integer(file.changes, 'pull-request file changes'),
          deletions: integer(file.deletions, 'pull-request file deletions'),
          filename: filename.text,
          ...(previousFilename === undefined ? {} : { previousFilename: previousFilename.text }),
          status: status.text,
        });
      }
    }
    return {
      body: body.text,
      comments,
      ...(itemType === 'pull-request' ? { files } : {}),
      labels,
      title: title.text,
      truncated:
        title.truncated ||
        body.truncated ||
        commentsTruncated ||
        filesTruncated ||
        value.labels.length > labels.length,
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

  /** List a complete bounded projection of top-level comments through GitHub's issue API. */
  async listIssueComments(
    owner: string,
    name: string,
    number: number,
  ): Promise<GitHubIssueCommentPage> {
    const comments: GitHubCanonicalIssueComment[] = [];
    let hasNextPage = false;
    for (let page = 1; page <= maximumTrackedCommentPages; page += 1) {
      const response = await this.#api(
        [
          '--method',
          'GET',
          `${this.#itemEndpoint(owner, name, number)}/comments`,
          '-F',
          `per_page=${pageSize}`,
          '-F',
          `page=${page}`,
          '--jq',
          `[.[]|{databaseId:.id,nodeId:.node_id,author:(if .user==null then null else {login:.user.login,nodeId:.user.node_id,type:.user.type} end),body:((.body//"")[0:${maximumCommentBodyLength + 1}]),bodyLength:(.body//""|length),createdAt:.created_at,updatedAt:.updated_at}]`,
        ],
        'issue comments',
      );
      if (!Array.isArray(response.value)) {
        throw new Error('GitHub returned invalid issue comments.');
      }
      comments.push(...response.value.map(issueComment));
      hasNextPage = response.hasNextPage;
      if (!hasNextPage) break;
    }
    return { comments, truncated: hasNextPage };
  }

  /** Re-read one exact canonical top-level comment before dispatch or publication. */
  async getIssueComment(
    owner: string,
    name: string,
    number: number,
    commentDatabaseId: number,
  ): Promise<GitHubCanonicalIssueComment> {
    if (!Number.isSafeInteger(commentDatabaseId) || commentDatabaseId < 1) {
      throw new Error('GitHub issue-comment database ids must be positive safe integers.');
    }
    const response = await this.#api(
      [
        '--method',
        'GET',
        `${repositoryEndpoint(owner, name)}/issues/comments/${commentDatabaseId}`,
        '--jq',
        `{databaseId:.id,nodeId:.node_id,issueUrl:.issue_url,author:(if .user==null then null else {login:.user.login,nodeId:.user.node_id,type:.user.type} end),body:((.body//"")[0:${maximumCommentBodyLength + 1}]),bodyLength:(.body//""|length),createdAt:.created_at,updatedAt:.updated_at}`,
      ],
      'issue comment',
    );
    const value = record(response.value, 'issue comment');
    let issueUrl: URL;
    try {
      issueUrl = new URL(string(value.issueUrl, 'issue-comment issue url'));
    } catch {
      throw new Error('GitHub returned an invalid issue-comment issue url.');
    }
    if (
      issueUrl.origin !== 'https://api.github.com' ||
      issueUrl.pathname.toLowerCase() !==
        `${repositoryEndpoint(owner, name)}/issues/${number}`.toLowerCase()
    ) {
      throw new Error('GitHub returned an issue comment for another work item.');
    }
    return issueComment(value);
  }

  async findOwnIssueComment(
    owner: string,
    name: string,
    number: number,
    marker: string,
  ): Promise<GitHubIssueCommentReceipt | undefined> {
    if (
      !/^<!-- agent-system-github-publication:(?:github-reply|initial-acknowledgment):[a-f0-9]{32} -->$/u.test(
        marker,
      )
    ) {
      throw new Error('GitHub notification publication markers are invalid.');
    }
    let hasNextPage = false;
    for (let page = 1; page <= maximumCommentPages; page += 1) {
      const response = await this.#api(
        [
          '--method',
          'GET',
          `${this.#itemEndpoint(owner, name, number)}/comments`,
          '-F',
          `per_page=${pageSize}`,
          '-F',
          `page=${page}`,
          '--jq',
          `[.[]|select(.body|contains(${JSON.stringify(marker)}))|{databaseId:.id,nodeId:.node_id,user:{login:.user.login,nodeId:.user.node_id,type:.user.type}}]`,
        ],
        'issue comments',
      );
      if (!Array.isArray(response.value))
        throw new Error('GitHub returned invalid issue comments.');
      for (const item of response.value) {
        const value = record(item, 'issue comment');
        const author = identity(value.user, 'issue-comment author');
        if (author.nodeId !== this.identity.nodeId) continue;
        return {
          databaseId: positiveInteger(value.databaseId, 'issue-comment database id'),
          nodeId: nodeId(value.nodeId, 'issue-comment node id'),
        };
      }
      hasNextPage = response.hasNextPage;
      if (!hasNextPage) return undefined;
    }
    if (hasNextPage) {
      throw new GitHubWorkEventClientError(
        'github-notification-comments-truncated',
        'GitHub issue comments exceeded the publication reconciliation boundary.',
        this.rateLimit,
      );
    }
    return undefined;
  }

  async createIssueComment(
    owner: string,
    name: string,
    number: number,
    body: string,
  ): Promise<GitHubIssueCommentReceipt> {
    if (!body || body.length > 1_024 || /\0/u.test(body)) {
      throw new Error('GitHub notification publication comments are invalid.');
    }
    const response = await this.#api(
      [
        '--method',
        'POST',
        `${this.#itemEndpoint(owner, name, number)}/comments`,
        '--input',
        '-',
        '--jq',
        '{databaseId:.id,nodeId:.node_id,body,user:{login:.user.login,nodeId:.user.node_id,type:.user.type}}',
      ],
      'issue-comment publication',
      JSON.stringify({ body }),
    );
    const value = record(response.value, 'published issue comment');
    const author = identity(value.user, 'published issue-comment author');
    if (
      author.nodeId !== this.identity.nodeId ||
      string(value.body, 'published issue-comment body') !== body
    ) {
      throw new Error('GitHub returned a conflicting published issue comment.');
    }
    return {
      databaseId: positiveInteger(value.databaseId, 'published issue-comment database id'),
      nodeId: nodeId(value.nodeId, 'published issue-comment node id'),
    };
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
