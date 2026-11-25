import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import codexStorageLocation, {
  codexAgentDatabases,
  codexPickupStore,
} from '../storage/codex-storage.ts';
import automationLedgerStorage from '../storage/automation-backend.ts';
import { bindAgentStore } from '../storage/backend.ts';
import {
  issuePickupAutomationId,
  issuePickupConfigurationCode,
  issuePickupErrorCode,
} from './issue-pickup-jobs.ts';
import { IntakeError } from '../../channels/github/intake/record-store.ts';
import type { ResolvedAutomation } from '../../manifest/automation-schema.ts';
import type { AgentManifest } from '../../manifest/types.ts';
import { AutomationError, CodexAutomationError } from './automation-errors.ts';
import { automationHash } from '../automation-hash.ts';
import type { AutomationThreadAdapter } from './automation-threads.ts';
import { automationRecordSchema, codexAutomationMarker } from './codex-automation-plan.ts';
import { nativeAutomationSchema, type readCodexAutomations } from './codex-automation-state.ts';
import { codexIntakeJobs, intakeAutomationId } from './codex-intake-policy.ts';
import type { CodexIntakeDependencies } from '../codex-intake.ts';
import { inspectCodexWorkspaceBinding } from '../identity/codex-workspace-binding.ts';

const hash = Type.String({ pattern: '^[a-f0-9]{64}$' });
const actionSchema = Type.Object(
  {
    manifestId: Type.String(),
    mode: Type.Union([Type.Literal('create'), Type.Literal('update')]),
    review: Type.Optional(Type.Boolean()),
    id: Type.Optional(Type.String()),
    expected: nativeAutomationSchema,
    removed: Type.Boolean(),
    retire: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const ledgerSchema = Type.Object(
  {
    version: Type.Literal(1),
    scope: hash,
    records: Type.Array(automationRecordSchema),
    binding: Type.Optional(
      Type.Object(
        { workspace: Type.String(), codexHome: Type.String(), agentId: Type.String() },
        { additionalProperties: false },
      ),
    ),
    retired: Type.Optional(Type.Array(automationRecordSchema)),
    pending: Type.Optional(
      Type.Object(
        {
          digest: hash,
          manifestDigest: Type.String(),
          action: actionSchema,
          beforeHash: Type.Optional(hash),
          othersHash: Type.Optional(hash),
          targetBefore: Type.Optional(
            Type.Object(
              { hash, nativeIds: Type.Array(Type.String()) },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
// discover ownership before validating payloads that another installation alone consumes.
const ownershipSchema = Type.Object(
  {
    version: ledgerSchema.properties.version,
    scope: hash,
    binding: ledgerSchema.properties.binding,
  },
  { additionalProperties: true },
);

export type Ledger = Static<typeof ledgerSchema>;
export interface CodexAutomationDependencies {
  codexHome?: string;
  readAutomations?: typeof readCodexAutomations;
  now?: () => number;
  inspectBinding?: typeof inspectCodexWorkspaceBinding;
  threadAdapter?: AutomationThreadAdapter;
  intake?: CodexIntakeDependencies;
}

function validOwner(
  value: unknown,
  scope: string,
  agentId: string,
): value is Static<typeof ownershipSchema> {
  if (!Value.Check(ownershipSchema, value) || value.scope !== scope) return false;
  const binding = value.binding;
  return (
    !binding ||
    (binding.agentId === agentId &&
      scope ===
        automationHash({
          runtime: 'codex',
          profile: binding.codexHome,
          workspaceDir: binding.workspace,
          agentId: binding.agentId,
        }))
  );
}

async function* ownershipCandidates(root: string) {
  for await (const { agentId, agent } of codexAgentDatabases(root)) {
    const { automationState } = await agent.read({ automationState: {} });
    for (const { scope, value } of automationState) {
      // Inspect the owner before loading another installation's registrations.
      yield {
        scope,
        agentId,
        header: value,
        read: automationLedgerStorage('codex', scope, agent).read,
      };
    }
  }
}

export async function readCodexAutomationSnapshot(
  pluginData: string,
  dependencies: CodexAutomationDependencies,
) {
  const inspection = await (dependencies.inspectBinding ?? inspectCodexWorkspaceBinding)(
    pluginData,
  );
  const requestedHome = resolve(
    dependencies.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  );
  const codexHome = await realpath(requestedHome).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return requestedHome;
    throw error;
  });
  const root = resolve(pluginData);
  const ready =
    inspection.status === 'bound' &&
    inspection.preview.status === 'ready' &&
    inspection.preview.manifest.status === 'loaded';
  const retained: Ledger[] = [];
  for await (const candidate of ownershipCandidates(root)) {
    const { header } = candidate;
    if (!validOwner(header, candidate.scope, candidate.agentId))
      throw new CodexAutomationError('automation-ownership-invalid');
    if (
      header.binding &&
      isAbsolute(header.binding.codexHome) &&
      header.binding.codexHome !== codexHome
    ) {
      const ownerHome = await realpath(header.binding.codexHome).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return resolve(header.binding!.codexHome);
          throw error;
        },
      );
      // aliases of this home are not evidence of unrelated ownership.
      if (ownerHome !== codexHome) continue;
    }
    const value = await candidate.read();
    if (!validOwner(value, candidate.scope, candidate.agentId))
      throw new CodexAutomationError('automation-ownership-invalid');
    if (!Value.Check(ledgerSchema, value))
      throw new CodexAutomationError('automation-ownership-invalid');
    if (
      value.binding?.codexHome === codexHome &&
      (value.records.some((record) => record.id === intakeAutomationId) ||
        value.pending?.action.manifestId === intakeAutomationId)
    )
      retained.push(value);
  }
  let cleanupOnly = !ready;
  let loaded: { digest: string; manifest: AgentManifest };
  let workspace: string;
  if (
    ready &&
    inspection.status === 'bound' &&
    inspection.preview.status === 'ready' &&
    inspection.preview.manifest.status === 'loaded'
  ) {
    loaded = inspection.preview.manifest;
    workspace = inspection.preview.workspaceDir;
    const prior = retained.filter(
      (entry) =>
        (entry.binding!.workspace !== workspace ||
          entry.binding!.agentId !== loaded.manifest.agent.id) &&
        (entry.pending ||
          entry.records.some((record) => record.id === intakeAutomationId && !record.removed)),
    );
    if (prior.length > 1) throw new CodexAutomationError('automation-ownership-conflict');
    if (prior[0]) {
      cleanupOnly = true;
      workspace = prior[0].binding!.workspace;
      loaded = {
        digest: 'cleanup-only',
        manifest: { schemaVersion: 1, agent: { id: prior[0].binding!.agentId } },
      };
    }
  } else {
    // cleanup uses verified private ownership even when desired policy cannot be parsed.
    const candidates = retained.filter(
      (entry) =>
        inspection.status !== 'bound' ||
        entry.binding!.workspace === inspection.binding.workspaceDir,
    );
    if (candidates.length !== 1) throw new CodexAutomationError('automation-binding-unavailable');
    const binding = candidates[0]!.binding!;
    workspace = binding.workspace;
    loaded = {
      digest: 'cleanup-only',
      manifest: { schemaVersion: 1, agent: { id: binding.agentId } },
    };
  }
  const scope = automationHash({
    runtime: 'codex',
    profile: codexHome,
    workspaceDir: workspace,
    agentId: loaded.manifest.agent.id,
  });
  const agent = await bindAgentStore(
    loaded.manifest.agent.id,
    codexStorageLocation(root),
    loaded.manifest.storage?.backend,
  );
  const storage = automationLedgerStorage('codex', scope, agent);
  let ledger: Ledger;
  try {
    const contents = await storage.read();
    const parsed = contents === undefined ? { version: 1, scope, records: [] } : contents;
    if (!Value.Check(ledgerSchema, parsed) || !validOwner(parsed, scope, loaded.manifest.agent.id))
      throw new Error('invalid ledger');
    ledger = parsed;
    if (ledger.pending && !ledger.pending.targetBefore && !ledger.pending.beforeHash)
      throw new Error('missing pending snapshot');
    for (const record of ledger.records) {
      if (
        !record.definition.prompt.endsWith(codexAutomationMarker(scope, record.id)) ||
        (record.retired && (!record.removed || ledger.pending?.action.manifestId === record.id))
      )
        throw new Error('invalid marker');
    }
  } catch {
    throw new CodexAutomationError('automation-ownership-invalid');
  }
  const expected = structuredClone(ledger);
  const pickupStore = () =>
    codexPickupStore(pluginData, loaded.manifest.agent.id, loaded.manifest.storage?.backend);
  let jobs: ResolvedAutomation[] = [];
  let policyBlocker: string | undefined;
  let pickupBlocker: string | undefined;
  if (!cleanupOnly) {
    try {
      jobs = codexIntakeJobs(loaded.manifest, {
        entrypoint: resolve(process.argv[1]!),
        pluginData: root,
      });
      const policy = loaded.manifest.github?.notifications;
      if (policy?.issuePickup) {
        pickupBlocker = issuePickupConfigurationCode(policy);
        if (!pickupBlocker) {
          try {
            await (await pickupStore()).owner();
          } catch (error) {
            pickupBlocker = issuePickupErrorCode(error);
          }
        }
        if (pickupBlocker) jobs = jobs.filter((job) => job.id !== issuePickupAutomationId);
      }
    } catch (error) {
      cleanupOnly = true;
      policyBlocker =
        error instanceof IntakeError || error instanceof AutomationError
          ? error.code
          : 'intake-policy-invalid';
    }
  }
  return {
    loaded,
    workspace,
    codexHome,
    scope,
    agentStorage: agent,
    writeLedger: (next: Ledger) => storage.write(next, expected),
    ledger,
    root,
    dependencies,
    cleanupOnly,
    jobs,
    policyBlocker,
    pickupBlocker,
    pickupStore,
  };
}

export type CodexAutomationSnapshot = Awaited<ReturnType<typeof readCodexAutomationSnapshot>>;
