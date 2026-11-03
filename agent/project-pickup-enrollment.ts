import { IntakeError } from '../channels/github/intake/record-store.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import AssignmentClaimStore from './assignment-claim-store.ts';
import {
  projectPickupEnrollmentSchema,
  projectPickupPolicyDigest,
} from './project-pickup-authority.ts';
import projectPickupScope from './project-pickup-scope.ts';
import type { GitHubNotificationPolicy } from '../channels/github/workflow-policy.ts';
import type { ProjectPickupClient } from '../channels/github/provider/project-pickup-client.ts';
import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import acquirePrivateStateFileLock from '../core/private-state-file-lock.ts';

const maximumBytes = 4 * 1024 * 1024;
const text = Type.String({ minLength: 1, maxLength: 4096 });
const recordSchema = Type.Object(
  {
    enrollment: projectPickupEnrollmentSchema,
    instanceId: text,
    timezone: text,
    nativeId: Type.Optional(text),
    repository: text,
  },
  { additionalProperties: false },
);
const schema = Type.Object(
  { version: Type.Literal(1), records: Type.Array(recordSchema) },
  { additionalProperties: false },
);
export type PickupEnrollment = Static<typeof recordSchema>;

/** installation enrollment owns native timing; repository routing owns work placement. */
export default class ProjectPickupEnrollmentStore {
  readonly file: PrivateStateFile;
  readonly path: string;
  constructor(readonly root: string) {
    this.path = join(root, 'project-pickup-enrollments.json');
    // installation metadata only: no per-run history. Match the instance identity ledger
    // emergency byte budget; oversized writes preserve the last committed registry.
    this.file = new PrivateStateFile({
      path: this.path,
      directories: [root],
      currentUid: process.getuid?.(),
      label: 'project pickup enrollment',
      maximumBytes,
    });
  }

  async read() {
    const raw = await this.file.read();
    if (raw === undefined) return { version: 1 as const, records: [] as PickupEnrollment[] };
    const state: unknown = JSON.parse(raw);
    if (!Value.Check(schema, state)) throw new IntakeError('project-pickup-enrollment-invalid');
    return state;
  }

  async owner() {
    const identity = await new AssignmentClaimStore(this.root).inspect();
    if (!identity) throw new IntakeError('instance-install-required');
    return identity;
  }

  async inspect(policy: GitHubNotificationPolicy, runtime: 'codex' | 'openclaw', scope: string) {
    const identity = await this.owner();
    const matches = (await this.read()).records.filter(
      (record) => record.enrollment.scope === scope && record.enrollment.runtime === runtime,
    );
    if (matches.length !== 1) throw new IntakeError('project-pickup-activation-required');
    const record = matches[0]!;
    if (
      record.instanceId !== identity.instanceId ||
      !policy.projectPickup ||
      !policy.runtimes.includes(runtime)
    )
      throw new IntakeError('project-pickup-enrollment-changed');
    return record;
  }

  async prepare(input: {
    policy: GitHubNotificationPolicy;
    runtime: 'codex' | 'openclaw';
    scope: string;
    workspaceDir: string;
    agentId: string;
    client: ProjectPickupClient;
    timezone: string;
    now: number;
    reconcile?: (record: PickupEnrollment, commit: () => Promise<void>) => Promise<void>;
  }) {
    const identity = await this.owner();
    const pickup = input.policy.projectPickup!;
    const [owner, name] = pickup.projects[0]!.repository.split('/') as [string, string];
    const repository = await input.client.getRepository(owner, name);
    const milestone = await projectPickupScope(input.policy, input.client, repository);
    if (!milestone) throw new IntakeError('project-pickup-milestone-invalid');
    await ensurePrivateStateDirectories({
      directories: [this.root],
      currentUid: process.getuid?.(),
      label: 'project pickup enrollment',
    });
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30_000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      const currentIdentity = await this.owner();
      if (currentIdentity.instanceId !== identity.instanceId)
        throw new IntakeError('project-pickup-enrollment-changed');
      const state = await this.read();
      const matches = state.records.filter(
        (record) =>
          record.enrollment.scope === input.scope && record.enrollment.runtime === input.runtime,
      );
      if (matches.length > 1) throw new IntakeError('project-pickup-enrollment-conflict');
      const existing = matches[0];
      if (existing) {
        if (
          existing.enrollment.workspaceDir !== input.workspaceDir ||
          existing.enrollment.agentId !== input.agentId
        )
          throw new IntakeError('project-pickup-enrollment-conflict');
        if (
          existing.enrollment.account.nodeId !== input.client.identity.nodeId ||
          existing.instanceId !== identity.instanceId
        )
          throw new IntakeError('project-pickup-enrollment-changed');
        const changed =
          existing.enrollment.repositoryNodeId !== repository.nodeId ||
          existing.enrollment.milestoneNodeId !== milestone.nodeId ||
          existing.enrollment.policyDigest !== projectPickupPolicyDigest(input.policy) ||
          existing.timezone !== input.timezone;
        if (changed && !input.reconcile) throw new IntakeError('project-pickup-enrollment-changed');
        const updated: PickupEnrollment = changed
          ? {
              ...existing,
              timezone: input.timezone,
              repository: pickup.projects[0]!.repository,
              enrollment: {
                ...existing.enrollment,
                repositoryNodeId: repository.nodeId,
                milestoneNodeId: milestone.nodeId,
                policyDigest: projectPickupPolicyDigest(input.policy),
              },
            }
          : existing;
        // Target and window edits do not change the native job or its activation.
        const commit = async () => {
          if (!changed) return;
          state.records[state.records.indexOf(existing)] = updated;
          if (!Value.Check(schema, state))
            throw new IntakeError('project-pickup-enrollment-invalid');
          if (
            Buffer.byteLength(
              JSON.stringify({
                ...state,
                records: state.records.map((entry) => ({ ...entry, nativeId: 'x'.repeat(4096) })),
              }),
            ) > maximumBytes
          )
            throw new IntakeError('project-pickup-enrollment-capacity');
          lock.assertHeld();
          await this.file.write(JSON.stringify(state));
        };
        if (input.reconcile) await input.reconcile(updated, commit);
        else await commit();
        return updated;
      }
      const record: PickupEnrollment = {
        instanceId: identity.instanceId,
        repository: pickup.projects[0]!.repository,
        timezone: input.timezone,
        enrollment: {
          id: randomUUID(),
          runtime: input.runtime,
          scope: input.scope,
          workspaceDir: input.workspaceDir,
          agentId: input.agentId,
          account: { login: input.client.identity.login, nodeId: input.client.identity.nodeId },
          repositoryNodeId: repository.nodeId,
          milestoneNodeId: milestone.nodeId,
          policyDigest: projectPickupPolicyDigest(input.policy),
          startedAt: input.now,
        },
      };
      state.records.push(record);
      // reserve the schema's full native-id allowance before admitting new enrollment.
      // completion and replacement must fit even when the provider returns a longer id.
      const reserved = {
        ...state,
        records: state.records.map((entry) => ({ ...entry, nativeId: 'x'.repeat(4096) })),
      };
      if (Buffer.byteLength(JSON.stringify(reserved)) > maximumBytes)
        throw new IntakeError('project-pickup-enrollment-capacity');
      lock.assertHeld();
      if (!Value.Check(schema, state)) throw new IntakeError('project-pickup-enrollment-invalid');
      await this.file.write(JSON.stringify(state));
      return record;
    } finally {
      await lock.release();
    }
  }

  async activate(id: string, nativeId: string, previousNativeId?: string) {
    const lock = await acquirePrivateStateFileLock(this.path, {
      staleMs: 30_000,
      retries: { retries: 0, factor: 1, minTimeout: 25, maxTimeout: 25 },
    });
    try {
      const state = await this.read();
      const record = state.records.find((entry) => entry.enrollment.id === id);
      if (!record || (record.nativeId && record.nativeId !== (previousNativeId ?? nativeId)))
        throw new IntakeError('project-pickup-enrollment-changed');
      record.nativeId = nativeId;
      lock.assertHeld();
      if (!Value.Check(schema, state)) throw new IntakeError('project-pickup-enrollment-invalid');
      await this.file.write(JSON.stringify(state));
    } finally {
      await lock.release();
    }
  }
}
