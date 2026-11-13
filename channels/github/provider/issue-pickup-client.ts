import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { providerDiagnosticSchema } from '../../../utils/provider-diagnostic.ts';

import {
  githubRepositoryEndpoint,
  githubWorkItemEndpoint,
  type default as GitHubWorkEventApiClient,
} from './work-event-api-client.ts';
import {
  githubResponseRecord,
  githubResponseWorkItem,
  githubWorkItemProjection,
} from './work-event-normalization.ts';
import type { GitHubNotificationIntakeClient } from './work-event-types.ts';

export const projectCandidateSchema = Type.Object(
  {
    nodeId: Type.String({ minLength: 1, maxLength: 4096 }),
    number: Type.Integer({ minimum: 1 }),
    title: Type.String({ maxLength: 4096 }),
    body: Type.Optional(Type.String()),
    blockedByOpenIssues: Type.Optional(Type.Boolean()),
    dependencyError: Type.Optional(
      Type.Object(
        {
          code: Type.String(),
          providerDiagnostic: Type.Optional(providerDiagnosticSchema),
        },
        { additionalProperties: false },
      ),
    ),
    labels: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 100 }),
    issueType: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Object(
          { name: Type.String({ minLength: 1, maxLength: 4096, pattern: '\\S' }) },
          { additionalProperties: false },
        ),
      ]),
    ),
  },
  { additionalProperties: false },
);
export type ProjectCandidate = Static<typeof projectCandidateSchema>;
export interface ProjectCandidateObservation {
  item: ReturnType<typeof githubResponseWorkItem>;
  candidate: ProjectCandidate;
}
const discoveryCandidateSchema = Type.Pick(projectCandidateSchema, ['nodeId', 'number']);
export interface IssuePickupClient extends GitHubNotificationIntakeClient {
  discoverPickupRepositories?(
    owner: string,
    page: number,
  ): Promise<{ repositories: string[]; nextPage?: number }>;
  discoverProject(
    owner: string,
    name: string,
    milestone: number | undefined,
    page: number,
  ): Promise<{ candidates: Array<Pick<ProjectCandidate, 'nodeId' | 'number'>>; nextPage?: number }>;
  projectCandidate(
    owner: string,
    name: string,
    number: number,
  ): Promise<ProjectCandidateObservation>;
  projectBlocked(owner: string, name: string, number: number): Promise<boolean>;
  assignProjectIssue(owner: string, name: string, number: number): Promise<void>;
}

const projection =
  '{nodeId:.node_id,number,title,labels:[.labels[].name]} + ' +
  '(if has("type") then {issueType:(if .type == null then null else {name:.type.name} end)} else {} end)';

/** fixed provider operations; selection and mutation recovery belong to the runtime journal. */
export default class GitHubIssuePickupClient {
  constructor(private readonly api: GitHubWorkEventApiClient) {}

  async discoverPickupRepositories(owner: string, page: number) {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(owner) ||
      !Number.isSafeInteger(page) ||
      page < 1
    )
      throw new Error('issue-pickup-page-invalid');
    const account = await this.api.request(
      [`/users/${owner}`, '--jq', '.type'],
      'pickup namespace',
    );
    if (account.value !== 'User' && account.value !== 'Organization')
      throw new Error('issue-pickup-namespace-invalid');
    const self =
      account.value === 'User' && owner.toLowerCase() === this.api.identity.login.toLowerCase();
    const result = await this.api.request(
      [
        '--method',
        'GET',
        account.value === 'Organization'
          ? `/orgs/${owner}/repos`
          : self
            ? '/user/repos'
            : `/users/${owner}/repos`,
        '-f',
        `type=${self ? 'owner' : 'all'}`,
        '-f',
        'sort=full_name',
        '-f',
        'direction=asc',
        '-F',
        'per_page=100',
        '-F',
        `page=${page}`,
        '--jq',
        '[.[] | {owner:.owner.login,name,archived,disabled,hasIssues:.has_issues}]',
      ],
      'pickup repositories',
    );
    // another user's public listing omits private repositories shared with this account.
    const shared =
      account.value === 'User' && !self
        ? await this.api.request(
            [
              '--method',
              'GET',
              '/user/repos',
              '-f',
              'affiliation=collaborator',
              '-f',
              'visibility=private',
              '-f',
              'sort=full_name',
              '-f',
              'direction=asc',
              '-F',
              'per_page=100',
              '-F',
              `page=${page}`,
              '--jq',
              '[.[] | {owner:.owner.login,name,archived,disabled,hasIssues:.has_issues}]',
            ],
            'shared pickup repositories',
          )
        : undefined;
    const schema = Type.Array(
      Type.Object(
        {
          owner: Type.String(),
          name: Type.String(),
          archived: Type.Boolean(),
          disabled: Type.Boolean(),
          hasIssues: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    );
    if (!Value.Check(schema, result.value)) throw new Error('issue-pickup-repositories-invalid');
    const sharedRepositories = shared?.value ?? [];
    if (!Value.Check(schema, sharedRepositories))
      throw new Error('issue-pickup-repositories-invalid');
    const repositories = [...result.value, ...sharedRepositories];
    return {
      repositories: repositories
        .filter(
          (repo) =>
            repo.owner.toLowerCase() === owner.toLowerCase() &&
            !repo.archived &&
            !repo.disabled &&
            repo.hasIssues &&
            /^[A-Za-z0-9_.-]+$/u.test(repo.name),
        )
        .map((repo) => `${repo.owner}/${repo.name}`)
        .filter((repository, index, all) => all.indexOf(repository) === index),
      ...(result.hasNextPage || shared?.hasNextPage ? { nextPage: page + 1 } : {}),
    };
  }

  async discoverProject(owner: string, name: string, milestone: number | undefined, page: number) {
    if (
      ![...(milestone === undefined ? [] : [milestone]), page].every(
        (n) => Number.isSafeInteger(n) && n > 0,
      )
    )
      throw new Error('issue-pickup-page-invalid');
    const result = await this.api.request(
      [
        '--method',
        'GET',
        `${githubRepositoryEndpoint(owner, name)}/issues`,
        ...(milestone === undefined ? [] : ['-F', `milestone=${milestone}`]),
        '-f',
        'state=open',
        '-F',
        'per_page=100',
        '-F',
        `page=${page}`,
        '--jq',
        '[.[]|select(.pull_request==null)|{nodeId:.node_id,number}]',
      ],
      'milestone issues',
    );
    if (!Value.Check(Type.Array(discoveryCandidateSchema, { maxItems: 100 }), result.value))
      throw new Error('issue-pickup-candidates-invalid');
    return { candidates: result.value, ...(result.hasNextPage ? { nextPage: page + 1 } : {}) };
  }

  async projectCandidate(
    owner: string,
    name: string,
    number: number,
  ): Promise<ProjectCandidateObservation> {
    const result = await this.api.request(
      [
        githubWorkItemEndpoint(owner, name, number),
        '--jq',
        `{item:${githubWorkItemProjection},candidate:${projection}}`,
      ],
      'pickup candidate',
    );
    const observation = githubResponseRecord(result.value, 'pickup candidate');
    if (!Value.Check(projectCandidateSchema, observation.candidate))
      throw new Error('issue-pickup-candidate-invalid');
    return {
      item: githubResponseWorkItem(observation.item),
      candidate: observation.candidate,
    };
  }

  async projectBlocked(owner: string, name: string, number: number) {
    for (let page = 1; ; page++) {
      const result = await this.api.request(
        [
          '--method',
          'GET',
          `${githubWorkItemEndpoint(owner, name, number)}/dependencies/blocked_by`,
          '-F',
          'per_page=100',
          '-F',
          `page=${page}`,
          '--jq',
          '[.[].state]',
        ],
        'pickup dependencies',
      );
      if (
        !Value.Check(
          Type.Array(Type.Union([Type.Literal('open'), Type.Literal('closed')])),
          result.value,
        )
      )
        throw new Error('issue-pickup-dependencies-invalid');
      if (result.value.includes('open')) return true;
      if (!result.hasNextPage) return false;
    }
  }

  async assignProjectIssue(owner: string, name: string, number: number) {
    await this.api.request(
      [
        '--method',
        'POST',
        `${githubWorkItemEndpoint(owner, name, number)}/assignees`,
        '--input',
        '-',
      ],
      'pickup assignment',
      JSON.stringify({ assignees: [this.api.identity.login] }),
    );
  }
}
