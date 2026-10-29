import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import {
  githubRepositoryEndpoint,
  githubWorkItemEndpoint,
  type default as GitHubWorkEventApiClient,
} from './work-event-api-client.ts';
import type { GitHubNotificationIntakeClient } from './work-event-types.ts';

export const projectCandidateSchema = Type.Object(
  {
    nodeId: Type.String({ minLength: 1, maxLength: 4096 }),
    number: Type.Integer({ minimum: 1 }),
    title: Type.String({ maxLength: 4096 }),
    body: Type.String({ maxLength: 32000 }),
    labels: Type.Array(Type.String({ maxLength: 4096 }), { maxItems: 100 }),
  },
  { additionalProperties: false },
);
export type ProjectCandidate = Static<typeof projectCandidateSchema>;
export interface ProjectPickupClient extends GitHubNotificationIntakeClient {
  discoverProject(
    owner: string,
    name: string,
    milestone: number,
    page: number,
  ): Promise<{ candidates: ProjectCandidate[]; nextPage?: number }>;
  projectCandidate(owner: string, name: string, number: number): Promise<ProjectCandidate>;
  projectBlocked(owner: string, name: string, number: number): Promise<boolean>;
  assignProjectIssue(owner: string, name: string, number: number): Promise<void>;
}

const projection = '{nodeId:.node_id,number,title,body:(.body//""),labels:[.labels[].name]}';

/** fixed provider operations; selection and mutation recovery belong to the runtime journal. */
export default class GitHubProjectPickupClient {
  constructor(private readonly api: GitHubWorkEventApiClient) {}

  async discoverProject(owner: string, name: string, milestone: number, page: number) {
    if (![milestone, page].every((n) => Number.isSafeInteger(n) && n > 0))
      throw new Error('project-pickup-page-invalid');
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
        `[.[]|select(.pull_request==null)|${projection}]`,
      ],
      'milestone issues',
    );
    if (!Value.Check(Type.Array(projectCandidateSchema, { maxItems: 100 }), result.value))
      throw new Error('project-pickup-candidates-invalid');
    return { candidates: result.value, ...(result.hasNextPage ? { nextPage: page + 1 } : {}) };
  }

  async projectCandidate(owner: string, name: string, number: number) {
    const result = await this.api.request(
      [githubWorkItemEndpoint(owner, name, number), '--jq', projection],
      'pickup candidate',
    );
    if (!Value.Check(projectCandidateSchema, result.value))
      throw new Error('project-pickup-candidate-invalid');
    return result.value;
  }

  async projectBlocked(owner: string, name: string, number: number) {
    const result = await this.api.request(
      [
        '--method',
        'GET',
        `${githubWorkItemEndpoint(owner, name, number)}/dependencies/blocked_by`,
        '-F',
        'per_page=100',
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
      throw new Error('project-pickup-dependencies-invalid');
    // incomplete dependencies cannot establish readiness.
    return result.hasNextPage || result.value.includes('open');
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
