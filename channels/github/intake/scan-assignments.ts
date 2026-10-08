import { GitHubWorkEventClientError } from '../provider/work-event-api-client.ts';
import { automationHash } from '../../../agent/automation-hash.ts';
import type { GitHubNotificationPolicy } from '../config-schema.ts';
import type { GitHubNotificationIntakeClient } from '../provider/work-event-types.ts';
import {
  githubRepositoryPath,
  githubIdentityMatches as identityMatches,
  type GitHubIdentity,
} from '../provider/work-item.ts';
import {
  type default as IntakeRecordStore,
  IntakeError,
  type IntakeRecord,
  type IntakeState,
} from './record-store.ts';

export interface AssignmentScanInput {
  store: IntakeRecordStore;
  workspaceDir: string;
  agentId: string;
  policy: GitHubNotificationPolicy;
  policyDigest: string;
  now: number;
  activate?: boolean;
  connect(signal: AbortSignal): Promise<GitHubNotificationIntakeClient>;
  assertCurrent(): Promise<void>;
}

/** admission evidence only: no workspaces, chats, model decisions, or publication. */
export default async function scanAssignments(input: AssignmentScanInput) {
  return input.store.exclusive(async (previous, save, signal) => {
    if (!input.activate && !previous) throw new IntakeError('intake-activation-required');
    if (!input.activate && previous?.policyDigest !== input.policyDigest)
      throw new IntakeError('intake-policy-reconciliation-required');
    if (!input.activate && previous?.blocker && previous.blocker.retryAfter > input.now)
      return { status: 'blocked', changed: false, code: previous.blocker.code };
    try {
      const client = await input.connect(signal);
      const account: GitHubIdentity = client.identity;
      if (previous && !identityMatches(previous.account, account))
        throw new IntakeError('intake-account-changed');
      const state: IntakeState = previous
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
      const discovery = await client.discoverAssigned(new Date(state.baselineAt).toISOString(), [
        'issue',
      ]);
      if (discovery.truncated || discovery.incomplete)
        throw new IntakeError('intake-search-incomplete');
      const records: IntakeRecord[] = [];
      const seen = new Set(state.records.map((r) => r.id));
      for (const candidate of discovery.candidates) {
        if (candidate.itemType !== 'issue') continue;
        const coordinates = githubRepositoryPath(candidate.repositoryPath);
        if (
          !input.policy.allowedRepositoryOwners.some(
            (owner) => owner.login.toLowerCase() === coordinates.owner.toLowerCase(),
          )
        )
          continue;
        const repository = await client.getRepository(coordinates.owner, coordinates.name);
        if (
          repository.archived ||
          repository.disabled ||
          !input.policy.allowedRepositoryOwners.some((owner) =>
            identityMatches(owner, repository.owner),
          )
        )
          continue;
        const item = await client.getItem(coordinates.owner, coordinates.name, candidate.number);
        if (
          item.nodeId !== candidate.nodeId ||
          item.databaseId !== candidate.databaseId ||
          item.number !== candidate.number
        )
          throw new IntakeError('intake-resource-changed');
        if (
          item.itemType !== 'issue' ||
          item.state !== 'open' ||
          !item.assignees.some((identity) => identityMatches(identity, account))
        )
          continue;
        const history = await client.listAssignmentEvents(
          coordinates.owner,
          coordinates.name,
          item.number,
        );
        if (history.truncated) throw new IntakeError('intake-assignment-history-incomplete');
        const event = history.events
          .filter((event) => identityMatches(event.assignee, account))
          .sort(
            (a, b) =>
              Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.databaseId - a.databaseId,
          )[0];
        if (
          !event ||
          event.event !== 'assigned' ||
          Date.parse(event.createdAt) <= state.baselineAt ||
          event.actor.type !== 'User' ||
          !input.policy.issueAssignment?.allowed.some((actor) =>
            identityMatches(actor, event.actor),
          )
        )
          continue;
        const id = automationHash([state.scope, repository.nodeId, item.nodeId, event.nodeId]);
        if (seen.has(id)) continue;
        seen.add(id);
        records.push({
          version: 1,
          id,
          scope: state.scope,
          receiving: state.account,
          workspaceDir: state.workspaceDir,
          agentId: state.agentId,
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
            mode: input.policy.issueAssignment.mode,
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
        });
      }
      const verified = await input.connect(signal);
      if (!identityMatches(verified.identity, account))
        throw new IntakeError('intake-account-changed');
      await input.assertCurrent();
      state.policyDigest = input.policyDigest;
      state.checkpoint = input.now;
      state.lastAttemptAt = input.now;
      state.records.push(...records);
      const recovered = Boolean(state.blocker);
      delete state.blocker;
      await save(state);
      return {
        status: 'ready',
        changed: records.length > 0 || recovered,
        admitted: records.length,
        baselineAt: state.baselineAt,
        checkpoint: state.checkpoint,
      };
    } catch (error) {
      const diagnostic =
        error instanceof GitHubWorkEventClientError ? error.providerDiagnostic : undefined;
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
        await save({
          ...previous,
          lastAttemptAt: input.now,
          blocker: {
            code,
            since: changed ? input.now : previous.blocker!.since,
            retryAfter,
          },
        });
        return { status: 'blocked', code, changed };
      }
      throw new IntakeError(code);
    }
  });
}
