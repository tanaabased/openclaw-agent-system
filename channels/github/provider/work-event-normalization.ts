import type { GitHubCanonicalIssueComment } from './comment-admission.ts';
import type { GitHubIdentity } from './work-item.ts';
import { defaultMaximumCommentCharacters } from './comment-limit.ts';

export const maximumPublicationBodyLength = 1_200;

/** retain only an owned field label, never the rejected provider value. */
class GitHubResponseError extends Error {
  readonly code: string;

  constructor(label: string) {
    const field = /^[a-z][a-z -]{0,95}$/u.test(label) ? label : 'response';
    super(`GitHub returned invalid ${field}.`);
    this.code = `github-response-invalid-${field.replaceAll(' ', '-')}`;
  }
}

export function githubResponseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubResponseError(`${label} data`);
  }
  return value as Record<string, unknown>;
}

export function githubResponseString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new GitHubResponseError(label);
  return value;
}

export function githubResponseInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new GitHubResponseError(label);
  }
  return Number(value);
}

export function githubResponsePositiveInteger(value: unknown, label: string): number {
  const parsed = githubResponseInteger(value, label);
  if (parsed < 1) throw new GitHubResponseError(label);
  return parsed;
}

export function githubResponseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new GitHubResponseError(label);
  return value;
}

export function githubResponseNodeId(value: unknown, label: string): string {
  const parsed = githubResponseString(value, label);
  if (parsed.length > 255 || parsed.includes('\0') || /\s/u.test(parsed)) {
    throw new GitHubResponseError(label);
  }
  return parsed;
}

export function githubResponseTimestamp(value: unknown, label: string): string {
  const parsed = githubResponseString(value, label);
  if (Number.isNaN(Date.parse(parsed))) throw new GitHubResponseError(label);
  return parsed;
}

export function githubResponseHasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

export function githubResponseBoundedProse(
  value: unknown,
  label: string,
  maximumLength: number,
): { text: string; truncated: boolean } {
  if (value === null) return { text: '', truncated: false };
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new GitHubResponseError(label);
  }
  return {
    text: value.slice(0, maximumLength),
    truncated: value.length > maximumLength,
  };
}

function githubResponseBoundedCharacters(
  value: unknown,
  label: string,
  maximumLength: number,
): { text: string; truncated: boolean } {
  if (value === null) return { text: '', truncated: false };
  if (typeof value !== 'string' || value.includes('\0')) {
    throw new GitHubResponseError(label);
  }
  const characters = [...value];
  return {
    text: characters.slice(0, maximumLength).join(''),
    truncated: characters.length > maximumLength,
  };
}

export function githubResponseIdentity(value: unknown, label: string): GitHubIdentity {
  const item = githubResponseRecord(value, label);
  const login = githubResponseString(item.login, `${label} login`);
  const identityNodeId = githubResponseNodeId(item.nodeId, `${label} node id`);
  const type = githubResponseString(item.type, `${label} type`);
  const stem = type === 'Bot' ? login.replace(/\[bot\]$/u, '') : login;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(stem)) {
    throw new GitHubResponseError(`${label} login`);
  }
  return {
    login,
    nodeId: identityNodeId,
    type,
  };
}

export function githubResponseOptionalIdentity(
  value: unknown,
  label: string,
): GitHubIdentity | undefined {
  return value === null || value === undefined ? undefined : githubResponseIdentity(value, label);
}

export function githubResponseGitRef(value: unknown, label: string): string {
  const parsed = githubResponseString(value, label);
  if (parsed.length > 255 || githubResponseHasControlCharacter(parsed)) {
    throw new GitHubResponseError(label);
  }
  return parsed;
}

export function githubResponseGitSha(value: unknown, label: string): string {
  const parsed = githubResponseString(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(parsed)) {
    throw new GitHubResponseError(label);
  }
  return parsed;
}

export function githubResponseRepositoryReference(
  value: unknown,
  label: string,
): { databaseId: number; nodeId: string } {
  const repository = githubResponseRecord(value, label);
  return {
    databaseId: githubResponsePositiveInteger(repository.databaseId, `${label} database id`),
    nodeId: githubResponseNodeId(repository.nodeId, `${label} node id`),
  };
}

export function githubResponseOptionalRepositoryReference(
  value: unknown,
  label: string,
): { databaseId: number; nodeId: string } | undefined {
  return value === null || value === undefined
    ? undefined
    : githubResponseRepositoryReference(value, label);
}

export function githubResponseIssueComment(
  value: unknown,
  maximumCommentCharacters = defaultMaximumCommentCharacters,
): GitHubCanonicalIssueComment {
  const item = githubResponseRecord(value, 'issue comment');
  const body = githubResponseBoundedCharacters(
    item.body,
    'issue-comment body',
    maximumCommentCharacters,
  );
  const bodyLength = githubResponseInteger(item.bodyLength, 'issue-comment body length');
  return {
    author: githubResponseOptionalIdentity(item.author, 'issue-comment author'),
    body: body.text,
    bodyTruncated: body.truncated || bodyLength > maximumCommentCharacters,
    createdAt: githubResponseTimestamp(item.createdAt, 'issue-comment creation time'),
    databaseId: githubResponsePositiveInteger(item.databaseId, 'issue-comment database id'),
    nodeId: githubResponseNodeId(item.nodeId, 'issue-comment node id'),
    updatedAt: githubResponseTimestamp(item.updatedAt, 'issue-comment update time'),
  };
}
