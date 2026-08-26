import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import {
  isGitHubNotificationLifecycleId,
  type GitHubNotificationLifecycleId,
} from '../lifecycles/types.ts';
import { isGitHubNotificationEventId, type GitHubNotificationEventId } from '../events/types.ts';
import type { GitHubNotificationModeId } from '../modes/types.ts';
import { maximumGitHubNotificationReplyLength } from '../publication/limits.ts';
import {
  githubNotificationPublicationText,
  parseGitHubNotificationPublicationTarget,
  type GitHubNotificationPublicationIntent,
} from '../publication/publication.ts';

export type GitHubNotificationCommentTurnStatus =
  'admitted' | 'baseline' | 'rejected' | 'responded';

export interface GitHubNotificationActiveTurnState {
  eventId: GitHubNotificationEventId;
  sourceId: string;
}

export interface GitHubNotificationConversationSource {
  itemType: 'issue' | 'pull-request';
  number: number;
}

export interface GitHubNotificationDeliveryPullRequestState {
  baselineEstablished: boolean;
  eventRecorded: boolean;
  handoff?: GitHubNotificationPublicationPendingState | GitHubNotificationPublicationPublishedState;
  nodeId: string;
  number: number;
  status: 'closed' | 'merged' | 'open';
}

export interface GitHubNotificationPublicationPendingState {
  commentDatabaseId?: number;
  commentNodeId?: string;
  publicText: string;
  publicTextDigest: string;
  status: 'pending';
  target: string;
}

export interface GitHubNotificationPublicationPublishedState {
  commentDatabaseId: number;
  commentNodeId: string;
  publicText: string;
  publicTextDigest: string;
  status: 'published';
  target: string;
}

export interface GitHubNotificationPublicationWithheldState {
  reasonCode: string;
  status: 'withheld';
}

export type GitHubNotificationPublicationState =
  | GitHubNotificationPublicationPendingState
  | GitHubNotificationPublicationPublishedState
  | GitHubNotificationPublicationWithheldState;

export type GitHubNotificationAssignmentAcknowledgmentState =
  GitHubNotificationPublicationPendingState | GitHubNotificationPublicationPublishedState;

export interface GitHubNotificationImplementationState {
  status: 'completed' | 'delivery-pending' | 'pending';
}

export interface GitHubNotificationCommentRevisionState {
  bodyDigest: string;
  commentDatabaseId: number;
  failureCode?: string;
  publication?: GitHubNotificationPublicationState;
  reasonCode?: string;
  revisionId: string;
  source: GitHubNotificationConversationSource;
  status: GitHubNotificationCommentTurnStatus;
}

export interface GitHubNotificationConversation {
  acknowledgment?: GitHubNotificationAssignmentAcknowledgmentState;
  activeTurn?: GitHubNotificationActiveTurnState;
  assignmentResponse?: GitHubNotificationPublicationState;
  baselineEstablished: boolean;
  deliveryPullRequest?: GitHubNotificationDeliveryPullRequestState;
  implementation?: GitHubNotificationImplementationState;
  itemKey: string;
  lifecycleId: GitHubNotificationLifecycleId;
  mode: GitHubNotificationModeId;
  revisions: Record<string, GitHubNotificationCommentRevisionState>;
}

export interface GitHubNotificationConversationState {
  agentId: string;
  conversations: Record<string, GitHubNotificationConversation>;
  schemaVersion: 7;
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

function validSource(value: unknown): value is GitHubNotificationConversationSource {
  return (
    record(value) &&
    onlyKeys(value, ['itemType', 'number']) &&
    (value.itemType === 'issue' || value.itemType === 'pull-request') &&
    Number.isSafeInteger(value.number) &&
    Number(value.number) > 0
  );
}

function sameSource(
  left: GitHubNotificationConversationSource,
  right: GitHubNotificationConversationSource,
): boolean {
  return left.itemType === right.itemType && left.number === right.number;
}

function validPullRequestHandoff(value: unknown, conversationId: string): boolean {
  return (
    value === undefined ||
    (validPublication(value, conversationId, 'pull-request-handoff') &&
      record(value) &&
      value.status !== 'withheld')
  );
}

function validDeliveryPullRequest(
  value: unknown,
  conversationId: string,
): value is GitHubNotificationDeliveryPullRequestState {
  return (
    record(value) &&
    onlyKeys(value, [
      'baselineEstablished',
      'eventRecorded',
      'handoff',
      'nodeId',
      'number',
      'status',
    ]) &&
    typeof value.baselineEstablished === 'boolean' &&
    typeof value.eventRecorded === 'boolean' &&
    validPullRequestHandoff(value.handoff, conversationId) &&
    nodeId(value.nodeId) &&
    Number.isSafeInteger(value.number) &&
    Number(value.number) > 0 &&
    (value.status === 'open' || value.status === 'closed' || value.status === 'merged')
  );
}

export function githubNotificationPublicTextDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validPublication(
  value: unknown,
  conversationId: string,
  expectedIntent: GitHubNotificationPublicationIntent,
): boolean {
  if (
    expectedIntent !== 'initial-acknowledgment' &&
    record(value) &&
    value.status === 'withheld' &&
    onlyKeys(value, ['reasonCode', 'status'])
  ) {
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
    value.publicText.length > maximumGitHubNotificationReplyLength ||
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
    if (target.intent !== expectedIntent || target.conversationId !== conversationId) return false;
    if (
      githubNotificationPublicationText(expectedIntent, [{ text: value.publicText }]) !==
      value.publicText
    ) {
      return false;
    }
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

function validRevision(
  value: unknown,
  conversationId: string,
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7,
): boolean {
  if (
    !record(value) ||
    !onlyKeys(value, [
      'bodyDigest',
      'commentDatabaseId',
      'failureCode',
      'publication',
      'reasonCode',
      'revisionId',
      ...(schemaVersion >= 7 ? ['source'] : []),
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
  if (schemaVersion >= 7 && !validSource(value.source)) return false;
  if (value.status === 'responded') {
    return validPublication(value.publication, conversationId, 'github-reply');
  }
  return value.publication === undefined;
}

function validActiveTurn(value: unknown): boolean {
  return (
    record(value) &&
    onlyKeys(value, ['eventId', 'sourceId']) &&
    isGitHubNotificationEventId(value.eventId) &&
    nodeId(value.sourceId)
  );
}

function validImplementation(
  value: unknown,
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7,
): value is GitHubNotificationImplementationState {
  if (!record(value)) return false;
  return (
    onlyKeys(value, ['status']) &&
    (value.status === 'pending' ||
      value.status === 'completed' ||
      (schemaVersion >= 6 && value.status === 'delivery-pending'))
  );
}

function validImplementationRelationship(
  implementation: unknown,
  assignmentResponse: unknown,
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7,
): boolean {
  if (implementation === undefined) return true;
  if (!validImplementation(implementation, schemaVersion) || !record(assignmentResponse)) {
    return false;
  }
  return implementation.status === 'completed' || implementation.status === 'delivery-pending'
    ? assignmentResponse.status === 'published'
    : assignmentResponse.status === 'pending' || assignmentResponse.status === 'published';
}

function validConversation(
  value: unknown,
  conversationId: string,
  schemaVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7,
): boolean {
  if (
    !record(value) ||
    !onlyKeys(value, [
      ...(schemaVersion >= 3 ? ['acknowledgment'] : []),
      ...(schemaVersion >= 2 ? ['activeTurn'] : []),
      ...(schemaVersion >= 4 ? ['assignmentResponse'] : []),
      ...(schemaVersion >= 5 ? ['implementation'] : []),
      'baselineEstablished',
      ...(schemaVersion >= 7 ? ['deliveryPullRequest'] : []),
      'itemKey',
      'lifecycleId',
      'mode',
      'revisions',
    ]) ||
    (value.acknowledgment !== undefined &&
      !validPublication(value.acknowledgment, conversationId, 'initial-acknowledgment')) ||
    (value.activeTurn !== undefined && !validActiveTurn(value.activeTurn)) ||
    (value.assignmentResponse !== undefined &&
      !validPublication(value.assignmentResponse, conversationId, 'assignment-response')) ||
    typeof value.baselineEstablished !== 'boolean' ||
    !validImplementationRelationship(
      value.implementation,
      value.assignmentResponse,
      schemaVersion,
    ) ||
    typeof value.itemKey !== 'string' ||
    !/^github:[^:\s\0]+:[1-9]\d*$/u.test(value.itemKey) ||
    !isGitHubNotificationLifecycleId(value.lifecycleId) ||
    (schemaVersion >= 7 &&
      value.deliveryPullRequest !== undefined &&
      !validDeliveryPullRequest(value.deliveryPullRequest, conversationId)) ||
    value.mode !== 'work' ||
    !record(value.revisions) ||
    Object.keys(value.revisions).length > maximumRevisions
  ) {
    return false;
  }
  const ownerSource = conversationSource(conversationId);
  const deliveryPullRequest =
    schemaVersion >= 7 && record(value.deliveryPullRequest) ? value.deliveryPullRequest : undefined;
  if (schemaVersion >= 7 && deliveryPullRequest !== undefined && value.lifecycleId !== 'issue') {
    return false;
  }
  return Object.entries(value.revisions).every(([key, revision]) => {
    if (!nodeId(key) || !validRevision(revision, conversationId, schemaVersion)) return false;
    if (schemaVersion < 7 || !record(revision) || !validSource(revision.source)) return true;
    const revisionSource = revision.source;
    return (
      sameSource(revisionSource, ownerSource) ||
      (revisionSource.itemType === 'pull-request' &&
        deliveryPullRequest !== undefined &&
        Number(deliveryPullRequest.number) === revisionSource.number)
    );
  });
}

function conversationSource(conversationId: string): GitHubNotificationConversationSource {
  const match = /^github:(issue|pull-request|pull-request-review):[^:\s\0]+:([1-9]\d*)$/u.exec(
    conversationId,
  );
  if (!match) throw new Error('GitHub notification conversation ids are invalid.');
  return {
    itemType: match[1] === 'issue' ? 'issue' : 'pull-request',
    number: Number(match[2]),
  };
}

function migrateConversation(
  conversationId: string,
  value: GitHubNotificationConversation,
): GitHubNotificationConversation {
  const source = conversationSource(conversationId);
  return {
    ...value,
    revisions: Object.fromEntries(
      Object.entries(value.revisions).map(([commentNodeId, revision]) => [
        commentNodeId,
        {
          ...revision,
          source,
        },
      ]),
    ),
  } as GitHubNotificationConversation;
}

/** Decode bounded lifecycle-conversation state without admitting provider prose. */
export function decodeGitHubNotificationConversationState(
  value: unknown,
  expectedAgentId: string,
): GitHubNotificationConversationState | undefined {
  if (
    !record(value) ||
    !onlyKeys(value, ['agentId', 'conversations', 'schemaVersion', 'workspaceDir']) ||
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 &&
      value.schemaVersion !== 4 &&
      value.schemaVersion !== 5 &&
      value.schemaVersion !== 6 &&
      value.schemaVersion !== 7) ||
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
        validConversation(conversation, key, value.schemaVersion as 1 | 2 | 3 | 4 | 5 | 6 | 7),
    )
  ) {
    return undefined;
  }
  if (value.schemaVersion === 7) {
    return value as unknown as GitHubNotificationConversationState;
  }
  return {
    agentId: value.agentId,
    conversations: Object.fromEntries(
      Object.entries(value.conversations).map(([conversationId, conversation]) => [
        conversationId,
        migrateConversation(conversationId, conversation as GitHubNotificationConversation),
      ]),
    ),
    schemaVersion: 7,
    workspaceDir: value.workspaceDir,
  } as GitHubNotificationConversationState;
}

export function createGitHubNotificationConversationState(
  agentId: string,
  workspaceDir: string,
): GitHubNotificationConversationState {
  return { agentId, conversations: {}, schemaVersion: 7, workspaceDir };
}
