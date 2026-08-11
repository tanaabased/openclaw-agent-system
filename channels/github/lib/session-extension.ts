import { isAbsolute } from 'node:path';

import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

export const githubNotificationSessionExtensionNamespace = 'work-item';
export const githubNotificationSessionEntrySlot = 'agentSystemGitHubNotification';

export interface GitHubNotificationSessionMetadata {
  assignmentEventId: string;
  itemNumber: number;
  itemType: 'issue' | 'pull-request';
  repositoryId: string;
  schemaVersion: 1;
  status: 'active' | 'briefing' | 'retired';
  worktreeBranch: string;
  worktreePath: string;
}

type SessionExtensionRegistration = Parameters<
  OpenClawPluginApi['session']['state']['registerSessionExtension']
>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return isNonEmptyString(value) && value.length <= maximumLength;
}

/** Validate the value-free GitHub work-item metadata projected into a session row. */
export function parseGitHubNotificationSessionMetadata(
  value: unknown,
): GitHubNotificationSessionMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const allowedKeys = new Set([
    'assignmentEventId',
    'itemNumber',
    'itemType',
    'repositoryId',
    'schemaVersion',
    'status',
    'worktreeBranch',
    'worktreePath',
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return undefined;
  if (value.schemaVersion !== 1) return undefined;
  if (!isBoundedString(value.assignmentEventId, 256)) return undefined;
  if (!Number.isSafeInteger(value.itemNumber) || (value.itemNumber as number) < 1) {
    return undefined;
  }
  if (value.itemType !== 'issue' && value.itemType !== 'pull-request') return undefined;
  if (!isBoundedString(value.repositoryId, 256)) return undefined;
  if (value.status !== 'active' && value.status !== 'briefing' && value.status !== 'retired') {
    return undefined;
  }
  if (!isBoundedString(value.worktreeBranch, 255)) return undefined;
  if (!isBoundedString(value.worktreePath, 4096) || !isAbsolute(value.worktreePath)) {
    return undefined;
  }
  return value as unknown as GitHubNotificationSessionMetadata;
}

export const githubNotificationSessionExtension: SessionExtensionRegistration = {
  description: 'Value-free Agent System GitHub notification work-item metadata.',
  namespace: githubNotificationSessionExtensionNamespace,
  project({ state }) {
    return parseGitHubNotificationSessionMetadata(state) ? state : undefined;
  },
  sessionEntrySlotKey: githubNotificationSessionEntrySlot,
  sessionEntrySlotSchema: {
    additionalProperties: false,
    properties: {
      assignmentEventId: { minLength: 1, type: 'string' },
      itemNumber: { minimum: 1, type: 'integer' },
      itemType: { enum: ['issue', 'pull-request'], type: 'string' },
      repositoryId: { minLength: 1, type: 'string' },
      schemaVersion: { const: 1, type: 'integer' },
      status: { enum: ['active', 'briefing', 'retired'], type: 'string' },
      worktreeBranch: { minLength: 1, type: 'string' },
      worktreePath: { minLength: 1, type: 'string' },
    },
    required: [
      'assignmentEventId',
      'itemNumber',
      'itemType',
      'repositoryId',
      'schemaVersion',
      'status',
      'worktreeBranch',
      'worktreePath',
    ],
    type: 'object',
  },
};
