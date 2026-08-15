import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import type { GitHubNotificationLifecycleId } from '../lifecycles/types.ts';
import { parseGitHubNotificationPublicationTarget } from './publication.ts';

export type GitHubNotificationCommentTurnStatus =
  'admitted' | 'baseline' | 'rejected' | 'responded';

export interface GitHubNotificationCommentPublicationPendingState {
  commentDatabaseId?: number;
  commentNodeId?: string;
  publicText: string;
  publicTextDigest: string;
  status: 'pending';
  target: string;
}

export interface GitHubNotificationCommentPublicationPublishedState {
  commentDatabaseId: number;
  commentNodeId: string;
  publicText: string;
  publicTextDigest: string;
  status: 'published';
  target: string;
}

export interface GitHubNotificationCommentPublicationWithheldState {
  reasonCode: string;
  status: 'withheld';
}

export type GitHubNotificationCommentPublicationState =
  | GitHubNotificationCommentPublicationPendingState
  | GitHubNotificationCommentPublicationPublishedState
  | GitHubNotificationCommentPublicationWithheldState;

export interface GitHubNotificationCommentRevisionState {
  bodyDigest: string;
  commentDatabaseId: number;
  failureCode?: string;
  publication?: GitHubNotificationCommentPublicationState;
  reasonCode?: string;
  revisionId: string;
  status: GitHubNotificationCommentTurnStatus;
}

export interface GitHubNotificationConversation {
  baselineEstablished: boolean;
  itemKey: string;
  lifecycleId: GitHubNotificationLifecycleId;
  mode: 'work';
  revisions: Record<string, GitHubNotificationCommentRevisionState>;
}

export interface GitHubNotificationConversationState {
  agentId: string;
  conversations: Record<string, GitHubNotificationConversation>;
  schemaVersion: 1;
  workspaceDir: string;
}

const maximumConversations = 500;
const maximumRevisions = 400;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
  );
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function nodeId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 255 && !/[\s\0]/u.test(value)
  );
}

function diagnosticCode(value: unknown): value is string | undefined {
  return (
    value === undefined || (typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,254}$/u.test(value))
  );
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

export function githubNotificationPublicTextDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validPublication(value: unknown, conversationId: string): boolean {
  if (record(value) && value.status === 'withheld' && onlyKeys(value, ['reasonCode', 'status'])) {
    return diagnosticCode(value.reasonCode) && value.reasonCode !== undefined;
  }
  if (
    !record(value) ||
    !onlyKeys(value, [
      'commentDatabaseId',
      'commentNodeId',
      'publicText',
      'publicTextDigest',
      'status',
      'target',
    ]) ||
    typeof value.publicText !== 'string' ||
    value.publicText.length < 1 ||
    value.publicText.length > 800 ||
    value.publicText.includes('\0') ||
    !digest(value.publicTextDigest) ||
    value.publicTextDigest !== githubNotificationPublicTextDigest(value.publicText) ||
    (value.status !== 'pending' && value.status !== 'published') ||
    typeof value.target !== 'string'
  ) {
    return false;
  }
  try {
    const target = parseGitHubNotificationPublicationTarget(value.target);
    if (target.intent !== 'github-reply' || target.conversationId !== conversationId) return false;
  } catch {
    return false;
  }
  const hasReceipt = value.commentDatabaseId !== undefined || value.commentNodeId !== undefined;
  return value.status === 'published'
    ? Number.isSafeInteger(value.commentDatabaseId) &&
        Number(value.commentDatabaseId) > 0 &&
        nodeId(value.commentNodeId)
    : !hasReceipt;
}

function validRevision(value: unknown, conversationId: string): boolean {
  if (
    !record(value) ||
    !onlyKeys(value, [
      'bodyDigest',
      'commentDatabaseId',
      'failureCode',
      'publication',
      'reasonCode',
      'revisionId',
      'status',
    ]) ||
    !digest(value.bodyDigest) ||
    !Number.isSafeInteger(value.commentDatabaseId) ||
    Number(value.commentDatabaseId) < 1 ||
    !diagnosticCode(value.failureCode) ||
    !diagnosticCode(value.reasonCode) ||
    !digest(value.revisionId) ||
    !['admitted', 'baseline', 'rejected', 'responded'].includes(String(value.status))
  ) {
    return false;
  }
  if (value.status === 'responded') return validPublication(value.publication, conversationId);
  return value.publication === undefined;
}

function validConversation(value: unknown, conversationId: string): boolean {
  if (
    !record(value) ||
    !onlyKeys(value, ['baselineEstablished', 'itemKey', 'lifecycleId', 'mode', 'revisions']) ||
    typeof value.baselineEstablished !== 'boolean' ||
    typeof value.itemKey !== 'string' ||
    !/^github:[^:\s\0]+:[1-9]\d*$/u.test(value.itemKey) ||
    !['issue', 'pull-request', 'pull-request-review'].includes(String(value.lifecycleId)) ||
    value.mode !== 'work' ||
    !record(value.revisions) ||
    Object.keys(value.revisions).length > maximumRevisions
  ) {
    return false;
  }
  return Object.entries(value.revisions).every(
    ([key, revision]) => nodeId(key) && validRevision(revision, conversationId),
  );
}

/** Decode bounded lifecycle-conversation state without admitting provider prose. */
export function decodeGitHubNotificationConversationState(
  value: unknown,
  expectedAgentId: string,
): GitHubNotificationConversationState | undefined {
  if (
    !record(value) ||
    !onlyKeys(value, ['agentId', 'conversations', 'schemaVersion', 'workspaceDir']) ||
    value.schemaVersion !== 1 ||
    value.agentId !== expectedAgentId ||
    typeof value.agentId !== 'string' ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(value.agentId) ||
    typeof value.workspaceDir !== 'string' ||
    !isAbsolute(value.workspaceDir) ||
    !record(value.conversations) ||
    Object.keys(value.conversations).length > maximumConversations
  ) {
    return undefined;
  }
  if (
    !Object.entries(value.conversations).every(
      ([key, conversation]) =>
        /^github:(?:issue|pull-request|pull-request-review):[^:\s\0]+:[1-9]\d*$/u.test(key) &&
        validConversation(conversation, key),
    )
  ) {
    return undefined;
  }
  return value as unknown as GitHubNotificationConversationState;
}

export function createGitHubNotificationConversationState(
  agentId: string,
  workspaceDir: string,
): GitHubNotificationConversationState {
  return { agentId, conversations: {}, schemaVersion: 1, workspaceDir };
}
