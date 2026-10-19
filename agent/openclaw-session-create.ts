import { realpath } from 'node:fs/promises';

import { validateSessionsCreateParams } from '@openclaw/gateway-protocol';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import { buildAgentMainSessionKey } from 'openclaw/plugin-sdk/routing';

import type { OpenClawDispatchRecord } from './openclaw-dispatch-state.ts';
import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import type { DispatchAuthority, DispatchRequest } from '../credentials/session-dispatch.ts';

export interface DispatchCaller {
  sessionKey: string;
  sessionId: string;
  runId: string;
  toolCallId: string;
}

export class IssueSessionMismatchError extends Error {
  constructor(readonly field: string) {
    super('dispatch-session-mismatch');
  }
}

export function sessionObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('dispatch-session-response-invalid');
  return value as Record<string, unknown>;
}

export async function describeIssueSession(
  request: DispatchRequest,
  record: OpenClawDispatchRecord,
  config: OpenClawConfig,
  retained = false,
) {
  const expected = record.request;
  if (!expected || !('key' in expected) || !record.sessionCreation)
    throw new Error('dispatch-session-intent-missing');
  const described = sessionObject(await request('sessions.describe', { key: expected.key }));
  if (!described.session) throw new Error('dispatch-session-reconcile-required');
  const row = sessionObject(described.session);
  const model =
    typeof row.model === 'string' && row.model.includes('/')
      ? row.model
      : `${String(row.modelProvider)}/${String(row.model)}`;
  const cwd = row.spawnedCwd ?? row.workspaceDir;
  const mainParent =
    (config.session?.dmScope ?? 'main') === 'main' && config.session?.scope !== 'global'
      ? buildAgentMainSessionKey({ agentId: expected.agentId, mainKey: config.session?.mainKey })
      : undefined;
  function match(condition: unknown, field: string): asserts condition {
    if (!condition) throw new IssueSessionMismatchError(field);
  }
  match(row.key === expected.key, 'key');
  match(row.agentId === expected.agentId, 'agentId');
  match(
    typeof row.sessionId === 'string' &&
      row.sessionId &&
      (!record.sessionCreation.sessionId || row.sessionId === record.sessionCreation.sessionId),
    'sessionId',
  );
  // Retained presentation proves session custody only; it grants no new workflow authority.
  if (retained) return row.sessionId;
  match(typeof cwd === 'string' && (await realpath(cwd)) === (await realpath(expected.cwd)), 'cwd');
  match(model === expected.model, 'model');
  match(row.thinkingLevel === expected.thinkingLevel, 'thinkingLevel');
  match(row.label === expected.label, 'label');
  match(row.category === expected.category, 'category');
  match(
    row.parentSessionKey === undefined || row.parentSessionKey === mainParent,
    'parentSessionKey',
  );
  match(!row.spawnedBy, 'spawnedBy');
  match(row.spawnDepth === undefined || row.spawnDepth === 0, 'spawnDepth');
  match(row.archived !== true && !row.archivedAt, 'archived');
  return row.sessionId;
}

export async function verifyEmptyIssueSession(
  request: DispatchRequest,
  record: OpenClawDispatchRecord,
  config: OpenClawConfig,
  requirePending = false,
) {
  const sessionId = await describeIssueSession(request, record, config);
  const history = sessionObject(
    await request('chat.history', {
      sessionKey:
        record.threadId ??
        (record.request && 'key' in record.request ? record.request.key : undefined),
      limit: 1,
    }),
  );
  const info = sessionObject(history.sessionInfo);
  if (
    history.sessionId !== sessionId ||
    info.hasActiveRun !== false ||
    (requirePending && sessionObject(history.pendingInputs).total !== 0) ||
    !Array.isArray(history.messages) ||
    history.messages.length !== 0
  )
    throw new Error('dispatch-session-not-empty-idle');
  return sessionId;
}

/** caller holds the dispatch journal lock; uncertain creation is read back, never resent. */
export default async function createIssueSession(input: {
  credential: Pick<SessionDispatchCredential, 'use'>;
  record: OpenClawDispatchRecord;
  save(): Promise<void>;
  authority: DispatchAuthority;
  config: OpenClawConfig;
}) {
  const { record, save, authority } = input;
  const params = record.request;
  const creation = record.sessionCreation;
  if (!params || !('key' in params) || !creation || !validateSessionsCreateParams(params))
    throw new Error('dispatch-session-intent-invalid');
  const guard = async () => {
    authority.signal?.throwIfAborted();
    await authority.assertCurrent?.();
    authority.signal?.throwIfAborted();
  };
  await guard();
  const reused = creation.attempted;
  return input.credential.use(authority, async (request) => {
    if (!creation.attempted) {
      await guard();
      creation.attempted = true;
      await save();
      await guard();
      const created = sessionObject(await request('sessions.create', params));
      if (
        created.key !== params.key ||
        typeof created.sessionId !== 'string' ||
        !created.sessionId ||
        created.runStarted !== false
      )
        throw new Error('dispatch-session-create-unverified');
      creation.sessionId = created.sessionId;
      await save();
    }
    creation.sessionId = await verifyEmptyIssueSession(request, record, input.config);
    await guard();
    creation.verified = true;
    record.threadId = params.key;
    record.effective = { status: 'verified', model: params.model, effort: params.thinkingLevel };
    record.phase = 'created';
    delete record.blocker;
    delete record.failureStage;
    await save();
    return {
      status: 'session-created' as const,
      id: record.id,
      effect: reused ? 'reconciled' : 'created',
      sessionKey: params.key,
      sessionId: creation.sessionId,
      label: params.label,
      group: params.category,
      workspace: params.cwd,
      model: params.model,
      effort: params.thinkingLevel,
      runStarted: false,
    };
  });
}
