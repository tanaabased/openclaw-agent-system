import {
  githubResponseBoundedProse,
  githubResponseHasControlCharacter,
  githubResponseInteger,
  githubResponseRecord,
  githubResponseString,
  githubResponseTimestamp,
} from './work-event-normalization.ts';
import {
  githubRepositoryEndpoint,
  githubWorkItemEndpoint,
  type default as GitHubWorkEventApiClient,
} from './work-event-api-client.ts';
import type {
  GitHubNotificationItemContext,
  GitHubNotificationItemContextComment,
  GitHubNotificationItemContextFile,
} from './work-event-types.ts';
import { nativeRoutingMetadata, routingMetadata } from './routing-metadata.ts';

const maximumItemContextComments = 50;
const maximumItemContextFiles = 100;

/** Fetch a bounded, prose-only projection for a later lifecycle turn. */
export default async function readItemContext(
  api: Pick<GitHubWorkEventApiClient, 'request'>,
  owner: string,
  name: string,
  number: number,
  itemType: 'issue' | 'pull-request' = 'issue',
  includeRoutingMetadata = false,
): Promise<GitHubNotificationItemContext> {
  const endpoint = githubWorkItemEndpoint(owner, name, number);
  const response = await api.request(
    [
      endpoint,
      '--jq',
      '{title,body,commentCount:.comments,labels:[.labels[]|(if type=="string" then . else .name end)]}',
    ],
    'item context',
  );
  const value = githubResponseRecord(response.value, 'item context');
  const title = githubResponseBoundedProse(value.title, 'item-context title', 512);
  if (!title.text.trim()) throw new Error('GitHub returned an invalid item-context title.');
  const body = githubResponseBoundedProse(value.body, 'item-context body', 24_000);
  const commentCount = githubResponseInteger(value.commentCount, 'item-context comment count');
  if (!Array.isArray(value.labels)) throw new Error('GitHub returned invalid issue labels.');
  const labels = value.labels.slice(0, 100).map((label) => {
    const parsed = githubResponseString(label, 'issue label');
    if (parsed.length > 100 || githubResponseHasControlCharacter(parsed)) {
      throw new Error('GitHub returned an invalid issue label.');
    }
    return parsed;
  });
  const comments: GitHubNotificationItemContextComment[] = [];
  let commentsTruncated = commentCount > maximumItemContextComments;
  if (commentCount > 0) {
    const commentValues: unknown[] = [];
    const firstPage = Math.max(1, Math.ceil(commentCount / maximumItemContextComments) - 1);
    let page = firstPage;
    let hasNextPage: boolean;
    do {
      const commentsResponse = await api.request(
        [
          '--method',
          'GET',
          `${endpoint}/comments`,
          '-F',
          `per_page=${maximumItemContextComments}`,
          '-F',
          `page=${page}`,
          '--jq',
          '[.[]|{authorLogin:(.user.login//"unknown"),body,createdAt:.created_at}]',
        ],
        'item-context comments',
      );
      if (!Array.isArray(commentsResponse.value)) {
        throw new Error('GitHub returned invalid item-context comments.');
      }
      commentValues.push(...commentsResponse.value);
      hasNextPage = commentsResponse.hasNextPage;
      page += 1;
    } while (hasNextPage && page < firstPage + 2);
    commentsTruncated ||=
      firstPage > 1 || hasNextPage || commentValues.length > maximumItemContextComments;
    for (const item of commentValues.slice(-maximumItemContextComments)) {
      const comment = githubResponseRecord(item, 'item-context comment');
      const authorLogin = githubResponseBoundedProse(
        comment.authorLogin,
        'item-context comment author',
        100,
      );
      if (!authorLogin.text) {
        throw new Error('GitHub returned an invalid item-context comment author.');
      }
      const commentBody = githubResponseBoundedProse(
        comment.body,
        'item-context comment body',
        2_000,
      );
      commentsTruncated ||= authorLogin.truncated || commentBody.truncated;
      comments.push({
        authorLogin: authorLogin.text,
        body: commentBody.text,
        createdAt: githubResponseTimestamp(comment.createdAt, 'item-context comment time'),
      });
    }
  }
  const files: GitHubNotificationItemContextFile[] = [];
  let filesTruncated = false;
  if (itemType === 'pull-request') {
    const filesResponse = await api.request(
      [
        '--method',
        'GET',
        `${githubRepositoryEndpoint(owner, name)}/pulls/${number}/files`,
        '-F',
        `per_page=${maximumItemContextFiles}`,
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
    for (const entry of filesResponse.value.slice(0, maximumItemContextFiles)) {
      const file = githubResponseRecord(entry, 'pull-request file');
      const filename = githubResponseBoundedProse(file.filename, 'pull-request filename', 1_024);
      const previousFilename =
        file.previousFilename === null || file.previousFilename === undefined
          ? undefined
          : githubResponseBoundedProse(
              file.previousFilename,
              'pull-request previous filename',
              1_024,
            );
      const status = githubResponseBoundedProse(file.status, 'pull-request file status', 32);
      if (!filename.text || !status.text) {
        throw new Error('GitHub returned an invalid pull-request file.');
      }
      filesTruncated ||=
        filename.truncated || previousFilename?.truncated === true || status.truncated;
      files.push({
        additions: githubResponseInteger(file.additions, 'pull-request file additions'),
        changes: githubResponseInteger(file.changes, 'pull-request file changes'),
        deletions: githubResponseInteger(file.deletions, 'pull-request file deletions'),
        filename: filename.text,
        ...(previousFilename === undefined ? {} : { previousFilename: previousFilename.text }),
        status: status.text,
      });
    }
  }
  let metadata;
  if (includeRoutingMetadata && itemType === 'issue') {
    let native = nativeRoutingMetadata(undefined);
    try {
      const fields = await api.request(
        [
          '--method',
          'GET',
          `${endpoint}/issue-field-values?per_page=100`,
          '-H',
          'X-GitHub-Api-Version: 2026-03-10',
        ],
        'issue routing metadata',
      );
      native = nativeRoutingMetadata(fields.value, fields.hasNextPage);
    } catch {
      // Optional metadata failure remains distinct from a missing field.
    }
    metadata = routingMetadata(native, body.text);
  }
  return {
    ...(metadata === undefined ? {} : { routingMetadata: metadata }),
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
