import GitHubIdentityCache from '../identity-cache.ts';
import { GitHubAccountClientError } from '../../../core/github-account-client.ts';
import DiscoveryBudget, { DiscoveryPaused } from '../../../agent/discovery-budget.ts';
import isFilesystemAccessError from '../../../utils/is-filesystem-access-error.ts';

import { GitHubWorkEventClientError } from '../provider/work-event-api-client.ts';
import { automationHash } from '../../../agent/automation-hash.ts';
import type { GitHubNotificationPolicy } from '../config-schema.ts';
import type { GitHubNotificationIntakeClient } from '../provider/work-event-types.ts';
import {
  githubRepositoryPath,
  githubIdentityMatches as identityMatches,
  type GitHubIdentity,
  type GitHubAssignedItemCandidate,
  type GitHubNotificationItemSelector,
} from '../provider/work-item.ts';
import {
  type default as IntakeRecordStore,
  IntakeError,
  type IntakeRecord,
  type IntakeState,
} from './record-store.ts';

export interface AssignmentScanInput {
  store: Pick<IntakeRecordStore, 'exclusive' | 'location'>;
  workspaceDir: string;
  agentId: string;
  policy: GitHubNotificationPolicy;
  policyDigest: string;
  now: number;
  activate?: boolean;
  budget?: DiscoveryBudget;
  selector?: GitHubNotificationItemSelector;
  connect(signal: AbortSignal): Promise<GitHubNotificationIntakeClient>;
  assertCurrent(): Promise<void>;
  readPolicy?(): Promise<{ policy: GitHubNotificationPolicy; digest: string }>;
}

interface AssignmentScanResult {
  status: 'ready' | 'blocked';
  changed: boolean;
  code?: string;
  recovered?: boolean;
  admitted?: number;
  baselineAt?: number;
  checkpoint?: number;
  more?: boolean;
  deferred?: number;
}

/** admission evidence only: no workspaces, chats, model decisions, or publication. */
export default async function scanAssignments(
  input: AssignmentScanInput,
): Promise<AssignmentScanResult> {
  if (input.selector?.itemType === 'pull-request')
    throw new IntakeError('intake-selector-unsupported');
  return input.store.exclusive(async (previous, persist, signal) => {
    let persistenceError: unknown;
    const save = async (state: IntakeState) => {
      try {
        await persist(state);
      } catch (error) {
        persistenceError = error;
        throw error;
      }
    };
    if (!input.activate && !previous) throw new IntakeError('intake-activation-required');
    if (
      !input.activate &&
      previous?.blocker &&
      previous.blocker.retryAfter > input.now &&
      ![
        'intake-policy-changed',
        'intake-policy-reconciliation-required',
        'intake-policy-disabled',
        'intake-resource-changed',
        'intake-assignment-history-incomplete',
      ].includes(previous.blocker.code)
    ) {
      const result = { status: 'blocked' as const, changed: false, code: previous.blocker.code };
      return result;
    }
    const budget = input.budget ?? new DiscoveryBudget(20000);
    let state: IntakeState | undefined;
    let admitted = 0;
    let next: IntakeState;
    let result: AssignmentScanResult;
    try {
      budget.check();
      const client = await input.connect(AbortSignal.any([signal, budget.signal]));
      const identities = new GitHubIdentityCache(input.store.location);
      await identities.resolve(input.policy, client, 'assignment');
      const account: GitHubIdentity = client.identity;
      if (previous && !identityMatches(previous.account, account))
        throw new IntakeError('intake-account-changed');
      state = previous
        ? structuredClone(previous)
        : {
            version: 1 as const,
            scope: input.store.location.scope,
            workspaceDir: input.workspaceDir,
            agentId: input.agentId,
            account: { login: account.login, nodeId: account.nodeId },
            policyDigest: input.policyDigest,
            baselineAt: input.now,
            records: [],
          };
      // repeat from the baseline: search indexing delays must not strand an eligible assignment.
      const discovery = input.selector
        ? {
            candidates: [
              {
                itemType: 'issue' as const,
                repositoryPath: `/repos/${input.selector.repository}`,
                number: input.selector.number,
                nodeId: undefined,
                databaseId: undefined,
              },
            ],
            incomplete: false,
            truncated: false,
          }
        : state.discovery?.pending.length
          ? {
              candidates: state.discovery.pending.map(
                (value) => JSON.parse(value) as GitHubAssignedItemCandidate,
              ),
              incomplete: false,
              truncated: false,
              nextPage: state.discovery.nextPage,
            }
          : await client.discoverAssigned(
              new Date(state.baselineAt).toISOString(),
              ['issue'],
              state.discovery?.page ?? 1,
            );
      if (discovery.truncated || discovery.incomplete)
        throw new IntakeError('intake-search-incomplete');
      const candidateKey = (
        candidate: Pick<GitHubAssignedItemCandidate, 'repositoryPath' | 'number'>,
      ) => automationHash([candidate.repositoryPath, candidate.number]);
      const candidates = [
        ...new Map(
          [
            ...(!input.selector &&
            !state.discovery?.pending.length &&
            (state.discovery?.page ?? 1) === 1
              ? (state.deferred ?? []).map(
                  ({ candidate }) => JSON.parse(candidate) as GitHubAssignedItemCandidate,
                )
              : []),
            ...discovery.candidates,
          ].map((candidate) => [candidateKey(candidate), candidate]),
        ).values(),
      ];
      const deferredBefore = automationHash(state.deferred ?? []);
      const progress = {
        observations: input.selector ? {} : (state.discovery?.observations ?? {}),
        page: state.discovery?.page ?? 1,
        pending: candidates.map((value) => JSON.stringify(value)),
        nextPage: 'nextPage' in discovery ? (discovery.nextPage ?? 1) : 1,
      };
      if (!input.selector) state.discovery = progress;
      await save(state);
      const records: IntakeRecord[] = [];
      const seen = new Set(state.records.map((r) => r.id));
      async function observeRead<T>(key: string, read: () => Promise<T>): Promise<T> {
        budget.check();
        if (progress.observations[key] !== undefined)
          return JSON.parse(progress.observations[key]!) as T;
        const value = await read();
        progress.observations[key] = JSON.stringify(value);
        await input.assertCurrent();
        await save(state!);
        return value;
      }
      for (const candidate of candidates) {
        if (input.readPolicy) {
          const live = await input.readPolicy();
          await identities.resolve(live.policy, client, 'assignment');
          input = { ...input, policy: live.policy, policyDigest: live.digest };
        }
        budget.check();
        await input.assertCurrent();
        const observe = async () => {
          if (candidate.itemType !== 'issue') return;
          const coordinates = githubRepositoryPath(candidate.repositoryPath);
          if (
            !input.policy.allowedRepositoryOwners.some(
              (owner) => owner.login.toLowerCase() === coordinates.owner.toLowerCase(),
            )
          )
            return;
          const repository = await observeRead('repository', () =>
            client.getRepository(coordinates.owner, coordinates.name),
          );
          if (
            repository.archived ||
            repository.disabled ||
            !input.policy.allowedRepositoryOwners.some((owner) =>
              identityMatches(owner, repository.owner),
            )
          )
            return;
          const item = await observeRead('issue', () =>
            client.getItem(coordinates.owner, coordinates.name, candidate.number),
          );
          if (
            (candidate.nodeId !== undefined && item.nodeId !== candidate.nodeId) ||
            (candidate.databaseId !== undefined && item.databaseId !== candidate.databaseId) ||
            item.number !== candidate.number
          )
            throw new IntakeError('intake-resource-changed');
          if (
            item.itemType !== 'issue' ||
            item.state !== 'open' ||
            !item.assignees.some((identity) => identityMatches(identity, account))
          )
            return;
          const history = await observeRead('history', () =>
            client.listAssignmentEvents(coordinates.owner, coordinates.name, item.number),
          );
          if (history.truncated) {
            delete progress.observations.history;
            throw new IntakeError('intake-assignment-history-incomplete');
          }
          const event = history.events
            .filter((event) => identityMatches(event.assignee, account))
            .sort(
              (a, b) =>
                Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
            )[0];
          if (
            !event ||
            event.event !== 'assigned' ||
            Date.parse(event.createdAt) <= state!.baselineAt ||
            event.actor.type !== 'User'
          )
            return;
          const id = automationHash([state!.scope, repository.nodeId, item.nodeId, event.nodeId]);
          const record: IntakeRecord = {
            version: 1,
            id,
            scope: state!.scope,
            receiving: state!.account,
            workspaceDir: state!.workspaceDir,
            agentId: state!.agentId,
            host: 'github.com',
            repository: {
              nodeId: repository.nodeId,
              databaseId: repository.databaseId,
              owner: { login: repository.owner.login, nodeId: repository.owner.nodeId },
              name: repository.name,
            },
            issue: { nodeId: item.nodeId, databaseId: item.databaseId, number: item.number },
            assignment: { ...event, event: 'assigned' },
            evidence: {
              policyDigest: input.policyDigest,
              mode: input.policy.issueAssignment!.mode,
              open: true,
              assigned: true,
              repositoryReadable: true,
              ownerPinned: true,
              actorPinned: true,
            },
            observedAt: input.now,
            admittedAt: input.now,
            status: 'admitted',
            requiresRevalidation: true,
          };
          const observation = {
            version: record.version,
            id: record.id,
            scope: record.scope,
            receiving: record.receiving,
            workspaceDir: record.workspaceDir,
            agentId: record.agentId,
            host: record.host,
            repository: record.repository,
            issue: record.issue,
            assignment: record.assignment,
            observedAt: record.observedAt,
          };
          state!.observedAssignments ??= [];
          const observedIndex = state!.observedAssignments.findIndex((entry) => entry.id === id);
          if (observedIndex < 0) state!.observedAssignments.push(observation);
          else state!.observedAssignments[observedIndex] = observation;
          if (
            seen.has(id) ||
            !input.policy.issueAssignment!.allowed.some((actor) =>
              identityMatches(actor, event.actor),
            )
          )
            return;
          seen.add(id);
          records.push(record);
        };
        const key = candidateKey(candidate);
        try {
          await observe();
          state.deferred = state.deferred?.filter((entry) => entry.key !== key);
        } catch (error) {
          const diagnostic =
            error instanceof GitHubWorkEventClientError ? error.providerDiagnostic : undefined;
          const localCode =
            error instanceof IntakeError &&
            ['intake-resource-changed', 'intake-assignment-history-incomplete'].includes(error.code)
              ? error.code
              : diagnostic?.classification === 'permission' ||
                  (diagnostic?.classification === 'unknown' && diagnostic.httpStatus === 404)
                ? 'intake-github-permission'
                : undefined;
          if (!localCode || error === persistenceError || budget.exhausted || signal.aborted)
            throw error;
          state.deferred = [
            ...(state.deferred ?? []).filter((entry) => entry.key !== key),
            {
              key,
              candidate: JSON.stringify(candidate),
              code: localCode,
              providerDiagnostic: diagnostic,
            },
          ];
        }
        state.records.push(...records.splice(0));
        admitted = state.records.length - (previous?.records.length ?? 0);
        progress.pending.shift();
        progress.observations = {};
        await input.assertCurrent();
        await save(state);
      }
      await input.assertCurrent();
      state.policyDigest = input.policyDigest;
      const more = !input.selector && progress.nextPage !== 1;
      if (more) state.discovery = { page: progress.nextPage, pending: [], nextPage: 1 };
      else if (!input.selector) {
        delete state.discovery;
        state.checkpoint = input.now;
      }
      state.lastAttemptAt = input.now;
      state.records.push(...records);
      const recovered = Boolean(state.blocker);
      delete state.blocker;
      result = {
        status: 'ready' as const,
        changed:
          admitted > 0 || recovered || deferredBefore !== automationHash(state.deferred ?? []),
        admitted,
        deferred: state.deferred?.length ?? 0,
        more,
        ...(recovered ? { recovered: true } : {}),
        baselineAt: state.baselineAt,
        checkpoint: state.checkpoint,
      };
      next = state;
    } catch (error) {
      if (error === persistenceError) throw error;
      if (error instanceof DiscoveryPaused || budget.exhausted) {
        if (!state) throw error;
        state.lastAttemptAt = input.now;
        await save(state);
        return { status: 'ready', changed: admitted > 0, admitted, more: true };
      }
      if (state) previous = state;
      if (isFilesystemAccessError(error)) throw error;
      const diagnostic =
        error instanceof GitHubWorkEventClientError || error instanceof GitHubAccountClientError
          ? error.providerDiagnostic
          : undefined;
      const code =
        error instanceof IntakeError
          ? error.code
          : diagnostic
            ? `intake-github-${diagnostic.classification}`
            : 'intake-provider-unavailable';
      const retryAfter = Math.min(
        input.now + 86_400_000,
        Math.max(
          input.now + 300_000,
          input.now + (diagnostic?.retryAfterMs ?? 0),
          diagnostic?.resetAt ?? 0,
        ),
      );
      if (previous) {
        const changed = previous.blocker?.code !== code;
        next = {
          ...previous,
          lastAttemptAt: input.now,
          blocker: {
            code,
            since: changed ? input.now : previous.blocker!.since,
            retryAfter,
            providerDiagnostic: diagnostic,
          },
        };
        result = { status: 'blocked' as const, code, changed };
      } else throw new IntakeError(code);
    }
    // local persistence failures must not be mistaken for provider failures.
    await save(next);
    return result;
  });
}
