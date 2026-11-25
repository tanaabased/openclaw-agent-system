import { IntakeError } from '../channels/github/intake/record-store.ts';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import AssignmentClaimStore from './tasks/dispatch/assignment-claim-store.ts';
import { issuePickupEnrollmentSchema, issuePickupPolicyDigest } from './issue-pickup-authority.ts';
import { pickupMilestones } from '../channels/github/issue-pickup-projects.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import type { IssuePickupClient } from '../channels/github/provider/issue-pickup-client.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';

import type { BoundStorage } from './storage/storage-lifecycle.ts';
import { withPrivateStateLock } from '../core/private-state-lock-context.ts';

const maximumBytes = 4 * 1024 * 1024;
const text = Type.String({ minLength: 1, maxLength: 4096 });
const recordSchema = Type.Object(
  {
    enrollment: issuePickupEnrollmentSchema,
    instanceId: text,
    timezone: text,
    nativeId: Type.Optional(text),
  },
  { additionalProperties: false },
);
const schema = Type.Object(
  { version: Type.Literal(1), records: Type.Array(recordSchema) },
  { additionalProperties: false },
);
export type PickupEnrollment = Static<typeof recordSchema>;

function assertEnrollmentCapacity(records: PickupEnrollment[]) {
  // Reserve the full native ID before admission so activation and replacement still fit.
  const reserved = records.map((entry) => ({ ...entry, nativeId: 'x'.repeat(4096) }));
  if (Buffer.byteLength(JSON.stringify({ version: 1, records: reserved })) > maximumBytes)
    throw new IntakeError('issue-pickup-enrollment-capacity');
}

/** installation enrollment owns native timing; repository routing owns work placement. */
export default class IssuePickupEnrollmentStore {
  readonly file: PrivateStateFile;
  readonly path: string;
  constructor(
    readonly root: string,
    readonly instance = new AssignmentClaimStore(root),
    private readonly sqlite?: { agentId: string; agent: BoundStorage['agent'] },
  ) {
    // retain existing enrollments; a terminology change must not create a new ledger.
    this.path = join(root, 'project-pickup-enrollments.json');
    // installation metadata only: no per-run history. Match the instance identity ledger
    // emergency byte budget; oversized writes preserve the last committed registry.
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [root],
      currentUid: process.getuid?.(),
      label: 'issue pickup enrollment',
      maximumBytes,
    });
  }

  async read() {
    if (this.sqlite) {
      const { agent, agentId } = this.sqlite;
      const { pickupEnrollments } = await agent.read({ pickupEnrollments: {} });
      const records = pickupEnrollments.map(({ runtime, scope, value }) => {
        if (
          !Value.Check(recordSchema, value) ||
          value.enrollment.agentId !== agentId ||
          value.enrollment.scope !== scope ||
          value.enrollment.runtime !== runtime
        )
          throw new IntakeError('issue-pickup-enrollment-invalid');
        return value;
      });
      return { version: 1 as const, records };
    }
    const raw = await this.file.read();
    if (raw === undefined) return { version: 1 as const, records: [] as PickupEnrollment[] };
    const state: unknown = JSON.parse(raw);
    if (!Value.Check(schema, state)) throw new IntakeError('issue-pickup-enrollment-invalid');
    return state;
  }

  private async save(
    state: Static<typeof schema>,
    record: PickupEnrollment,
    previous: PickupEnrollment | undefined,
    reserveCapacity: boolean,
  ) {
    if (!Value.Check(schema, state)) throw new IntakeError('issue-pickup-enrollment-invalid');
    if (!this.sqlite) {
      if (reserveCapacity) assertEnrollmentCapacity(state.records);
      await this.file.write(JSON.stringify(state));
      return record;
    }
    const { runtime, scope, agentId } = record.enrollment;
    if (agentId !== this.sqlite.agentId) throw new IntakeError('issue-pickup-enrollment-conflict');
    return this.sqlite.agent.changePickupEnrollment(
      { runtime, scope },
      (current) => {
        if (!previous && !current) return record;
        if (!current || !previous || current.enrollment.id !== previous.enrollment.id)
          throw new IntakeError('issue-pickup-enrollment-changed');
        // Activation owns the native job ID. Install owns the enrollment and its timezone.
        if (!reserveCapacity) {
          if (current.nativeId !== previous.nativeId && current.nativeId !== record.nativeId)
            throw new IntakeError('issue-pickup-enrollment-changed');
          return { ...current, nativeId: record.nativeId };
        }
        if (
          !isDeepStrictEqual(
            { ...current, nativeId: undefined },
            { ...previous, nativeId: undefined },
          )
        )
          throw new IntakeError('issue-pickup-enrollment-changed');
        return { ...record, ...(current.nativeId && { nativeId: current.nativeId }) };
      },
      reserveCapacity ? assertEnrollmentCapacity : undefined,
    );
  }

  private async edit<T>(operation: () => Promise<T>) {
    if (this.sqlite) return operation();
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'issue pickup enrollment',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30_000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      return await withPrivateStateLock(lock, operation);
    } finally {
      await lock.release();
    }
  }

  async owner() {
    const identity = await this.instance.inspect();
    if (!identity) throw new IntakeError('instance-install-required');
    return identity;
  }

  async inspect(policy: GitHubNotificationPolicy, runtime: 'codex' | 'openclaw', scope: string) {
    const identity = await this.owner();
    const matches = (await this.read()).records.filter(
      (record) => record.enrollment.scope === scope && record.enrollment.runtime === runtime,
    );
    if (matches.length !== 1) throw new IntakeError('issue-pickup-activation-required');
    const record = matches[0]!;
    if (
      record.instanceId !== identity.instanceId ||
      !policy.issuePickup ||
      !policy.runtimes.includes(runtime)
    )
      throw new IntakeError('issue-pickup-enrollment-changed');
    return record;
  }

  async prepare(input: {
    policy: GitHubNotificationPolicy;
    runtime: 'codex' | 'openclaw';
    scope: string;
    workspaceDir: string;
    agentId: string;
    client: IssuePickupClient;
    timezone: string;
    now: number;
    reconcile?: (record: PickupEnrollment, commit: () => Promise<void>) => Promise<void>;
  }) {
    const identity = await this.owner();
    const pickup = input.policy.issuePickup!;
    const targets = new Map<string, string | undefined>();
    for (const project of pickup.projects) {
      const [owner, name] = project.repository.split('/') as [string, string];
      const repository = name === '*' ? undefined : await input.client.getRepository(owner, name);
      if (
        repository &&
        `${repository.owner.login}/${repository.name}`.toLowerCase() !==
          project.repository.toLowerCase()
      )
        throw new IntakeError('issue-pickup-repository-changed');
      let milestoneNodeId: string | undefined;
      for (const reference of pickupMilestones(project)) {
        const [milestoneOwner, repo] = reference.repository.split('/') as [string, string];
        if (reference.repository !== project.repository.toLowerCase()) {
          const target = await input.client.getRepository(milestoneOwner, repo);
          if (`${target.owner.login}/${target.name}`.toLowerCase() !== reference.repository)
            throw new IntakeError('issue-pickup-milestone-invalid');
        }
        const milestone = await input.client.getMilestone?.(milestoneOwner, repo, reference.number);
        if (!milestone || milestone.number !== reference.number)
          throw new IntakeError('issue-pickup-milestone-invalid');
        milestoneNodeId ??= milestone.nodeId;
      }
      if (!repository) continue;
      if (targets.has(repository.nodeId))
        throw new IntakeError('issue-pickup-repository-duplicate');
      targets.set(repository.nodeId, milestoneNodeId);
    }
    // keep the original enrollment shape readable by existing intake receipts.
    // namespace enrollment has no repository identity; selected effects always bind a real one.
    const [repositoryNodeId, milestoneNodeId] = [...targets][0] ?? [
      `selection:${pickup.projects[0]!.repository.toLowerCase()}`,
      undefined,
    ];
    return this.edit(async () => {
      const currentIdentity = await this.owner();
      if (currentIdentity.instanceId !== identity.instanceId)
        throw new IntakeError('issue-pickup-enrollment-changed');
      const state = await this.read();
      const matches = state.records.filter(
        (record) =>
          record.enrollment.scope === input.scope && record.enrollment.runtime === input.runtime,
      );
      if (matches.length > 1) throw new IntakeError('issue-pickup-enrollment-conflict');
      const existing = matches[0];
      if (existing) {
        if (
          existing.enrollment.workspaceDir !== input.workspaceDir ||
          existing.enrollment.agentId !== input.agentId
        )
          throw new IntakeError('issue-pickup-enrollment-conflict');
        if (
          existing.enrollment.account.nodeId !== input.client.identity.nodeId ||
          existing.instanceId !== identity.instanceId
        )
          throw new IntakeError('issue-pickup-enrollment-changed');
        const changed =
          existing.enrollment.repositoryNodeId !== repositoryNodeId ||
          existing.enrollment.milestoneNodeId !== milestoneNodeId ||
          existing.enrollment.policyDigest !== issuePickupPolicyDigest(input.policy) ||
          existing.timezone !== input.timezone;
        if (changed && !input.reconcile) throw new IntakeError('issue-pickup-enrollment-changed');
        let updated: PickupEnrollment = changed
          ? {
              ...existing,
              timezone: input.timezone,
              enrollment: {
                ...existing.enrollment,
                repositoryNodeId,
                milestoneNodeId,
                policyDigest: issuePickupPolicyDigest(input.policy),
              },
            }
          : existing;
        // Target and window edits do not change the native job or its activation.
        const commit = async () => {
          if (!changed) return;
          state.records[state.records.indexOf(existing)] = updated;
          updated = await this.save(state, updated, existing, true);
        };
        if (input.reconcile) await input.reconcile(updated, commit);
        else await commit();
        return updated;
      }
      const record: PickupEnrollment = {
        instanceId: identity.instanceId,
        timezone: input.timezone,
        enrollment: {
          id: randomUUID(),
          runtime: input.runtime,
          scope: input.scope,
          workspaceDir: input.workspaceDir,
          agentId: input.agentId,
          account: { login: input.client.identity.login, nodeId: input.client.identity.nodeId },
          repositoryNodeId,
          milestoneNodeId,
          policyDigest: issuePickupPolicyDigest(input.policy),
          startedAt: input.now,
        },
      };
      state.records.push(record);
      await this.save(state, record, undefined, true);
      return record;
    });
  }

  async activate(id: string, nativeId: string, previousNativeId?: string) {
    return this.edit(async () => {
      const state = await this.read();
      const record = state.records.find((entry) => entry.enrollment.id === id);
      if (!record || (record.nativeId && record.nativeId !== (previousNativeId ?? nativeId)))
        throw new IntakeError('issue-pickup-enrollment-changed');
      const activated = { ...record, nativeId };
      state.records[state.records.indexOf(record)] = activated;
      await this.save(state, activated, record, false);
    });
  }
}
