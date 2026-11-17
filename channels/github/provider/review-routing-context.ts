import readItemContext from './read-item-context.ts';
import {
  githubResponsePositiveInteger,
  githubResponseRecord,
  githubResponseString,
} from './work-event-normalization.ts';
import type GitHubWorkEventApiClient from './work-event-api-client.ts';
import type { RoutingMetadata } from './routing-metadata.ts';

export interface ReviewRoutingContext {
  source: string;
  linkedIssue?: { source: string; title: string; metadata?: RoutingMetadata };
  linkedIssueStatus: 'unique' | 'missing' | 'ambiguous' | 'unavailable';
}

export default async function reviewRoutingContext(
  api: Pick<GitHubWorkEventApiClient, 'request'>,
  owner: string,
  name: string,
  number: number,
): Promise<ReviewRoutingContext> {
  const source = `https://github.com/${owner}/${name}/pull/${number}`;
  // Provider links, not arbitrary URLs or instructions in the PR body, select metadata.
  try {
    const response = await api.request(
      [
        'graphql',
        '-f',
        'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){closingIssuesReferences(first:2,userLinkedOnly:true){nodes{number title repository{name owner{login}}} pageInfo{hasNextPage}}}}}',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${number}`,
      ],
      'review linked issues',
    );
    const envelope = githubResponseRecord(response.value, 'review linked issues');
    if (envelope.errors) throw new Error('review-linked-issues-unavailable');
    const data = githubResponseRecord(envelope.data, 'review linked issue data');
    const repo = githubResponseRecord(data.repository, 'review repository');
    const pr = githubResponseRecord(repo.pullRequest, 'review pull request');
    const links = githubResponseRecord(pr.closingIssuesReferences, 'review linked issues');
    const page = githubResponseRecord(links.pageInfo, 'review linked issue page');
    if (!Array.isArray(links.nodes) || typeof page.hasNextPage !== 'boolean')
      throw new Error('review-linked-issues-unavailable');
    if (links.nodes.length > 1 || page.hasNextPage)
      return { source, linkedIssueStatus: 'ambiguous' };
    if (!links.nodes.length) return { source, linkedIssueStatus: 'missing' };
    const issue = githubResponseRecord(links.nodes[0], 'review linked issue');
    const issueRepo = githubResponseRecord(issue.repository, 'linked issue repository');
    const issueOwner = githubResponseString(
      githubResponseRecord(issueRepo.owner, 'linked issue owner').login,
      'linked issue owner',
    );
    const issueName = githubResponseString(issueRepo.name, 'linked issue repository');
    const issueNumber = githubResponsePositiveInteger(issue.number, 'linked issue number');
    const context = await readItemContext(
      api,
      issueOwner,
      issueName,
      issueNumber,
      'issue',
      true,
      false,
      true,
    );
    return {
      source,
      linkedIssueStatus: 'unique',
      linkedIssue: {
        source: `https://github.com/${issueOwner}/${issueName}/issues/${issueNumber}`,
        title: context.title,
        metadata: context.routingMetadata,
      },
    };
  } catch {
    return { source, linkedIssueStatus: 'unavailable' };
  }
}
