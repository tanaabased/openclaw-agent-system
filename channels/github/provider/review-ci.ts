import {
  githubRepositoryEndpoint,
  type default as GitHubWorkEventApiClient,
} from './work-event-api-client.ts';
import { githubResponseGitSha, githubResponseRecord } from './work-event-normalization.ts';
import { automationHash } from '../../../agent/automation-hash.ts';

export interface ReviewCI {
  head: string;
  merge?: string;
  state: 'running' | 'settled' | 'absent';
  passing: boolean;
  fingerprint?: string;
  changeFingerprint?: string;
}

export default async function readReviewCI(
  api: Pick<GitHubWorkEventApiClient, 'request'>,
  owner: string,
  name: string,
  number: number,
  expectedHead: string,
): Promise<ReviewCI> {
  const repository = githubRepositoryEndpoint(owner, name);
  githubResponseGitSha(expectedHead, 'review head');
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('review-pr-invalid');
  const response = await api.request(
    [
      'graphql',
      '-f',
      'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid baseRefOid body potentialMergeCommit{oid parents(first:2){nodes{oid} pageInfo{hasNextPage}}}}}}',
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${number}`,
    ],
    'review commit identity',
  );
  const envelope = githubResponseRecord(response.value, 'review commit identity');
  if (envelope.errors) throw new Error('review-ci-unavailable');
  const data = githubResponseRecord(envelope.data, 'review commit data');
  const repo = githubResponseRecord(data.repository, 'review repository');
  const pr = githubResponseRecord(repo.pullRequest, 'review pull request');
  if (pr.headRefOid !== expectedHead) throw new Error('review-head-changed');
  if (typeof pr.body !== 'string') throw new Error('review-description-unavailable');
  const base = githubResponseGitSha(pr.baseRefOid, 'review base');
  const revisions = [expectedHead];
  if (pr.potentialMergeCommit) {
    const merge = githubResponseRecord(pr.potentialMergeCommit, 'review merge commit');
    const parents = githubResponseRecord(merge.parents, 'review merge parents');
    const pageInfo = githubResponseRecord(parents.pageInfo, 'review merge parent page');
    if (
      pageInfo.hasNextPage !== false ||
      !Array.isArray(parents.nodes) ||
      !parents.nodes.some(
        (parent) => githubResponseRecord(parent, 'merge parent').oid === expectedHead,
      )
    )
      throw new Error('review-merge-unverified');
    revisions.push(githubResponseGitSha(merge.oid, 'review merge commit'));
  }
  let count = 0;
  let running = false;
  let passing = true;
  const evidence: unknown[] = [];
  for (const sha of new Set(revisions)) {
    for (const kind of ['checks', 'statuses', 'runs'] as const) {
      const latestRuns = new Map<string, number>();
      const endpoint =
        kind === 'checks'
          ? `${repository}/commits/${sha}/check-runs?filter=latest`
          : kind === 'statuses'
            ? `${repository}/commits/${sha}/status`
            : `${repository}/actions/runs?head_sha=${sha}`;
      for (let page = 1; ; page++) {
        const result = await api.request(
          ['--method', 'GET', endpoint, '-F', 'per_page=100', '-F', `page=${page}`],
          'review CI',
        );
        const value = githubResponseRecord(result.value, 'review CI');
        const entries =
          value[
            kind === 'checks' ? 'check_runs' : kind === 'statuses' ? 'statuses' : 'workflow_runs'
          ];
        if (!Array.isArray(entries)) throw new Error('review-ci-unavailable');
        for (const raw of entries) {
          const entry = githubResponseRecord(raw, 'review CI entry');
          if (kind !== 'statuses' && entry.head_sha !== sha)
            throw new Error('review-ci-revision-mismatch');
          if (kind === 'runs') {
            if (
              !Number.isSafeInteger(entry.workflow_id) ||
              !Number.isSafeInteger(entry.id) ||
              typeof entry.event !== 'string'
            )
              throw new Error('review-ci-unavailable');
            const key = JSON.stringify([entry.workflow_id, entry.event, entry.head_branch]);
            // GitHub returns workflow runs newest first; older runs of this workflow are superseded.
            const previous = latestRuns.get(key);
            if (previous !== undefined) {
              if (Number(entry.id) > previous) throw new Error('review-ci-order-unavailable');
              continue;
            }
            latestRuns.set(key, Number(entry.id));
          }
          evidence.push({
            sha,
            kind,
            id: entry.id,
            attempt: entry.run_attempt,
            name: entry.name ?? entry.context,
            status: entry.status ?? entry.state,
            conclusion: entry.conclusion,
            completedAt: entry.completed_at ?? entry.updated_at,
          });
          count++;
          if (kind === 'statuses') {
            if (!['pending', 'success', 'failure', 'error'].includes(String(entry.state)))
              throw new Error('review-ci-unavailable');
            running ||= entry.state === 'pending';
            passing &&= entry.state === 'success';
          } else {
            if (
              !['completed', 'queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(
                String(entry.status),
              )
            )
              throw new Error('review-ci-unavailable');
            running ||= entry.status !== 'completed';
            passing &&=
              entry.status === 'completed' &&
              ['success', 'neutral', 'skipped'].includes(String(entry.conclusion));
          }
        }
        if (!result.hasNextPage) break;
      }
    }
  }
  return {
    head: expectedHead,
    ...(revisions[1] ? { merge: revisions[1] } : {}),
    state: running ? 'running' : count ? 'settled' : 'absent',
    passing: count > 0 && passing,
    fingerprint: automationHash(evidence),
    changeFingerprint: automationHash([
      base,
      pr.body,
      evidence.map((entry) => automationHash(entry)).sort(),
    ]),
  };
}
