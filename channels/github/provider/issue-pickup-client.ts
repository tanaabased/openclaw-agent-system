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
  discoverProject(
    owner: string,
    name: string,
    milestone: number,
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

const projection = '{nodeId:.node_id,number,title,labels:[.labels[].name]}';

/** fixed provider operations; selection and mutation recovery belong to the runtime journal. */
export default class GitHubIssuePickupClient {
  constructor(private readonly api: GitHubWorkEventApiClient) {}

  async discoverProject(owner: string, name: string, milestone: number, page: number) {
    if (![milestone, page].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error('issue-pickup-page-invalid');
    const result = await this.api.request(
      [
        '--method',
        'GET',
        `${githubRepositoryEndpoint(owner, name)}/issues`,
        '-F',
        `milestone=${milestone}`,
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
