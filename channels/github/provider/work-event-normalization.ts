import type { GitHubCanonicalIssueComment } from '../conversation/comment-admission.ts';
import type { GitHubIdentity } from './work-item.ts';

export const maximumCommentBodyLength = 1_000;
export const maximumPublicationBodyLength = 1_200;

export function githubResponseRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`GitHub returned invalid ${label} data.`);
  }
  return value as Record<string, unknown>;
}

export function githubResponseString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`GitHub returned invalid ${label}.`);
  return value;
}

export function githubResponseInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return Number(value);
}

export function githubResponsePositiveInteger(value: unknown, label: string): number {
  const parsed = githubResponseInteger(value, label);
  if (parsed < 1) throw new Error(`GitHub returned invalid ${label}.`);
  return parsed;
}

export function githubResponseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`GitHub returned invalid ${label}.`);
  return value;
}

export function githubResponseNodeId(value: unknown, label: string): string {
  const parsed = githubResponseString(value, label);
  if (parsed.length > 255 || parsed.includes('\0') || /\s/u.test(parsed)) {
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return parsed;
}

export function githubResponseTimestamp(value: unknown, label: string): string {
  const parsed = githubResponseString(value, label);
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`GitHub returned invalid ${label}.`);
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
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return {
    text: value.slice(0, maximumLength),
    truncated: value.length > maximumLength,
  };
}

export function githubResponseIdentity(value: unknown, label: string): GitHubIdentity {
  const item = githubResponseRecord(value, label);
  const login = githubResponseString(item.login, `${label} login`);
  const identityNodeId = githubResponseNodeId(item.nodeId, `${label} node id`);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(login)) {
    throw new Error(`GitHub returned invalid ${label} login.`);
  }
  return {
    login,
    nodeId: identityNodeId,
    type: githubResponseString(item.type, `${label} type`),
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
    throw new Error(`GitHub returned invalid ${label}.`);
  }
  return parsed;
}

export function githubResponseGitSha(value: unknown, label: string): string {
  const parsed = githubResponseString(value, label).toLowerCase();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(parsed)) {
    throw new Error(`GitHub returned invalid ${label}.`);
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

export function githubResponseIssueComment(value: unknown): GitHubCanonicalIssueComment {
  const item = githubResponseRecord(value, 'issue comment');
  const body = githubResponseBoundedProse(
    item.body,
    'issue-comment body',
    maximumCommentBodyLength,
  );
  const bodyLength = githubResponseInteger(item.bodyLength, 'issue-comment body length');
  return {
    author: githubResponseOptionalIdentity(item.author, 'issue-comment author'),
    body: body.text,
    bodyTruncated: body.truncated || bodyLength > maximumCommentBodyLength,
    createdAt: githubResponseTimestamp(item.createdAt, 'issue-comment creation time'),
    databaseId: githubResponsePositiveInteger(item.databaseId, 'issue-comment database id'),
    nodeId: githubResponseNodeId(item.nodeId, 'issue-comment node id'),
    updatedAt: githubResponseTimestamp(item.updatedAt, 'issue-comment update time'),
  };
}
