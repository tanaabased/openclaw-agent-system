import { readCodexAutomationSnapshot } from '../agent/automations/codex-automation-snapshot.ts';
import { intakeAutomationId } from '../agent/automations/codex-intake-policy.ts';
import AutomationReportStore from '../agent/automations/automation-report-store.ts';
import { prepareAutomationReport } from '../agent/automations/automation-report.ts';
import AutomationThreads from '../agent/automations/automation-threads.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { codexSidebarJournal } from '../agent/storage/codex-storage.ts';
import automationLedgerStorage from '../agent/storage/automation-backend.ts';
import { codexAutomationMarker } from '../agent/automations/codex-automation-plan.ts';
import { automationHash } from '../agent/automation-hash.ts';
import {
  pickupDispatchScope,
  sqliteDispatchPersistence,
} from '../agent/storage/dispatch-backend.ts';
import CodexDispatchStore from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import OpenClawDispatchStore from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import { DirectEntryStore } from '../agent/tasks/direct-entry-store.ts';
import { entriesSchema } from '../agent/tasks/retirement/native-retirement.ts';
import { selectOpenClawTaskContext } from '../agent/tasks/context/openclaw-task-context.ts';
import { bindSqliteStorage } from '../agent/storage/agent-database.ts';
import { importAgentStorage, type ImportOptions } from '../scripts/import-agent-storage.ts';
import { gitWorktreeRepositoryDirectoryName } from '../tools/git/worktree-names.ts';

async function save(path: string, data: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(data), { mode: 0o600 });
}

describe('legacy agent storage import', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'storage-import-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it('should preview, import and retry scoped ' + runtime + ' state', async () => {
      const codex = runtime === 'codex';
      const workspace = join(root, 'workspace');
      const stateRoot = join(root, 'state');
      const privateRoot = join(root, 'private');
      const profile = codex ? join(root, 'profile') : stateRoot;
      const instance = codex
        ? join(stateRoot, 'instance')
        : join(privateRoot, 'agent-system-instance');
      const dispatch = codex ? stateRoot : join(privateRoot, 'agent-system-dispatch-v2');
      const intake = codex ? stateRoot : join(privateRoot, 'agent-system-intake-v2');
      const automations = codex ? stateRoot : join(stateRoot, 'agent-system-automations');
      const agentId = 'emori';
      const scope = automationHash({
        runtime,
        agentId,
        namespace: profile,
        workspaceDir: workspace,
      });
      const autoScope = automationHash({ runtime, agentId, profile, workspaceDir: workspace });
      const options: ImportOptions = {
        runtime,
        privateRoot,
        stateRoot,
        workspace,
        agentId,
        profile,
        repositories: [join(root, 'repos')],
        sessionScopes: [],
        apply: false,
      };
      const installation = {
        agentRoot: join(stateRoot, 'agent-system-storage'),
        installationRoot: instance,
        schemaRoot: resolve(import.meta.dirname, '../agent/storage'),
      };
      const db = bindSqliteStorage(installation, agentId);
      await assert.rejects(importAgentStorage(options), /install/);
      await db.agent.install();
      await db.installation.install();
      const id = randomUUID();
      const identity = { login: 'user', nodeId: 'U1', type: 'User' };
      const checkpoint = {
        version: 1,
        scope,
        workspaceDir: workspace,
        agentId,
        account: identity,
        policyDigest: 'test',
        baselineAt: 1,
        checkpoint: 2,
        records: [],
      };
      await save(join(intake, 'github-intake-' + scope + '.json'), checkpoint);
      await save(join(intake, 'github-identities-' + scope + '.json'), {
        version: 1,
        entries: { '@user': identity },
      });
      const session = 'thread';
      const sessionId = codex ? session : 'incarnation';
      const chat = automationHash({
        runtime,
        agentId,
        workspace,
        namespace: profile,
        session,
        incarnation: sessionId,
      });
      // A raw record can be isolated by the existing reader. Preserve its evidence verbatim.
      const record = {
        id: 'review',
        threadId: session,
        reviewPublication: { turnId: 'turn' },
        ...(!codex && { sessionCreation: { sessionId } }),
      };
      const enrollment = {
        enrollment: {
          id: 'enroll',
          agentId,
          workspaceDir: workspace,
          runtime,
          scope,
          account: { login: 'user', nodeId: 'U1' },
          repositoryNodeId: 'repo',
          policyDigest: 'test',
          startedAt: 1,
        },
        instanceId: id,
        timezone: 'UTC',
      };
      const pickupState = { enrollment: enrollment.enrollment, timezone: 'UTC', operations: [] };
      await save(join(dispatch, runtime + '-dispatch-' + scope + '.json'), {
        version: 4,
        scope,
        resetGeneration: 'saved',
        ...(codex && { projectPickup: pickupState }),
        records: [record],
      });
      if (!codex)
        await save(join(intake, runtime + '-dispatch-' + scope + '.json'), {
          version: 4,
          scope,
          resetGeneration: 'pickup',
          projectPickup: pickupState,
          records: [],
        });
      const receipt = {
        digest: 'retire',
        source: 'operator',
        turnId: 'turn',
        inputId: 'input',
        at: 1,
      };
      const orphan = 'a'.repeat(64);
      for (const key of [chat, orphan])
        await save(join(dispatch, 'github-native-retirement-' + key + '.json'), {
          scope: key,
          entries: [receipt],
        });
      await save(join(instance, 'project-pickup-enrollments.json'), {
        version: 1,
        records: [
          enrollment,
          { ...enrollment, enrollment: { ...enrollment.enrollment, agentId: 'another' } },
        ],
      });
      await save(join(instance, 'assignment-claims.json'), {
        version: 1,
        instanceId: id,
        displayName: 'local-agent',
        retiredInstanceIds: [],
        claims: { [scope]: { instanceId: id, attempted: true, firstPass: 'first' } },
      });
      const definition = {
        kind: 'heartbeat',
        destination: 'thread',
        targetThreadId: 'native-thread',
        name: 'job',
        prompt: codexAutomationMarker(autoScope, 'job'),
        status: 'ACTIVE',
        rrule: 'FREQ=DAILY',
        notificationPolicy: null,
      };
      const registration = { id: 'job', nativeId: 'native-job', removed: false };
      const ledger = {
        version: 1,
        scope: autoScope,
        records: [
          codex
            ? { ...registration, definition }
            : {
                ...registration,
                marker: 'agent-system:' + autoScope + ':job',
                hash: scope,
                triggerHash: scope,
                generation: 1,
                anchorMs: 1,
                pending: { kind: 'update', nativeHash: scope },
              },
        ],
        ...(codex && {
          binding: { agentId, workspace, codexHome: profile },
          retired: [],
          pending: {
            digest: scope,
            manifestDigest: scope,
            beforeHash: scope,
            action: {
              manifestId: 'job',
              id: 'native-job',
              mode: 'update',
              removed: false,
              expected: definition,
            },
          },
        }),
      };
      await save(
        join(automations, (codex ? 'codex-automations-' : 'automations-') + autoScope + '.json'),
        ledger,
      );
      await save(join(automations, 'automation-threads-' + autoScope + '.json'), {
        version: 1,
        scope: autoScope,
        records: [{ key: 'job', phase: 'ready', nativeId: 'native' }],
      });
      const repo = {
        repositoryId: 'repo',
        source: 'https://github.com/sample/repo.git',
        version: 1,
        path: join(root, 'repo'),
      };
      await save(
        join(
          options.repositories[0]!,
          gitWorktreeRepositoryDirectoryName('repo') + '.repository.json',
        ),
        repo,
      );
      const sourcePath = join(dispatch, runtime + '-dispatch-' + scope + '.json');
      const before = await readFile(sourcePath);
      const emptySidebar = {
        schemaVersion: 4,
        sections: [],
        unavailableHosts: [],
        unavailableSources: [],
      };
      if (codex) {
        const legacy = await codexSidebarJournal(stateRoot, profile, 'reports', 'file');
        assert.equal(
          (await legacy.apply('workspace', emptySidebar, 'thread')).status,
          'native-action',
        );
      }
      const reportId = randomUUID();
      const reportDirectory = join(automations, 'reports');
      if (!codex) {
        const files = new AutomationReportStore(reportDirectory);
        await files.write({
          version: 1,
          executionId: reportId,
          hash: 'job',
          manifestDigest: 'manifest',
          target: {
            agentId,
            workspaceDir: workspace,
            scope: autoScope,
            sessionKey: 'report-session',
          },
          input: prepareAutomationReport({
            id: 'job',
            executionId: reportId,
            startedAt: '2026-10-01T00:00:00Z',
            cancelled: false,
            result: { exitCode: 0, timedOut: false, truncated: false },
          }),
          state: 'uncertain',
        });
      }
      const foreignId = randomUUID();
      await db.installation.write([
        {
          table: 'instances',
          action: 'insert',
          row: {
            id: foreignId,
            value: {
              version: 1,
              instanceId: foreignId,
              displayName: 'existing-agent',
              retiredInstanceIds: [],
            },
          },
        },
      ]);
      for (const apply of [false, true])
        await assert.rejects(
          importAgentStorage({ ...options, apply }),
          /different instance identity/,
        );
      assert.equal((await db.installation.read({ instances: {} })).instances.length, 1);
      assert.equal(await db.agent.readIntake(scope), undefined);
      await db.installation.write([
        { table: 'instances', action: 'remove', key: { id: foreignId } },
      ]);
      const priorWorkspace = join(root, 'previous');
      const previousAgent = 'previous-agent';
      const intakeOnlyWorkspace = join(root, 'intake-only');
      const intakeOnlyScope = automationHash({
        runtime,
        agentId,
        namespace: profile,
        workspaceDir: intakeOnlyWorkspace,
      });
      if (codex) {
        await save(join(intake, 'github-intake-' + intakeOnlyScope + '.json'), {
          ...checkpoint,
          scope: intakeOnlyScope,
          workspaceDir: intakeOnlyWorkspace,
        });
        const priorScope = automationHash({
          runtime,
          agentId: previousAgent,
          profile,
          workspaceDir: priorWorkspace,
        });
        await save(join(automations, 'codex-automations-' + priorScope + '.json'), {
          version: 1,
          scope: priorScope,
          binding: { agentId: previousAgent, workspace: priorWorkspace, codexHome: profile },
          records: [
            {
              ...registration,
              id: intakeAutomationId,
              definition: {
                ...definition,
                prompt: codexAutomationMarker(priorScope, intakeAutomationId),
              },
            },
          ],
        });
      }
      const preview = await importAgentStorage(options);
      assert.equal(preview.agentRows.pickupEnrollments?.insert, 1);
      assert.deepEqual(preview.unselectedSessionScopes, [orphan]);
      assert.equal(await db.agent.readIntake(scope), undefined);
      options.apply = true;
      await importAgentStorage(options);
      if (codex) {
        assert.equal(
          (await db.agent.readIntake(intakeOnlyScope))?.workspaceDir,
          intakeOnlyWorkspace,
        );
        const recoveredOwner = await readCodexAutomationSnapshot(stateRoot, {
          codexHome: profile,
          storageBackend: 'sqlite',
        });
        assert.equal(recoveredOwner.cleanupOnly, true);
        assert.equal(recoveredOwner.loaded.manifest.agent.id, previousAgent);
        assert.equal(recoveredOwner.workspace, priorWorkspace);
        assert.ok(
          recoveredOwner.ledger.records.some((record) => record.nativeId === registration.nativeId),
        );
        const migrated = await codexSidebarJournal(stateRoot, profile, 'reports', 'sqlite');
        const recovered = await migrated.apply('workspace', emptySidebar, 'thread');
        assert.ok(
          recovered.status === 'incomplete' &&
            recovered.code === 'automation-sidebar-create-unresolved',
        );
      } else {
        const reports = new AutomationReportStore(reportDirectory, Date.now, {
          agentId,
          agent: db.agent,
        });
        assert.deepEqual(await reports.recoveryIds(), [reportId]);
        assert.equal((await reports.read(reportId))?.state, 'uncertain');
      }
      assert.deepEqual(await db.agent.readIntake(scope), checkpoint);
      assert.deepEqual(
        await automationLedgerStorage(runtime, automations, autoScope, db.agent).read(),
        ledger,
      );
      const records = await db.agent.read({
        dispatchRecords: { scope },
        directEntries: {},
        pickupEnrollments: {},
        automationState: {},
        automationThreads: {},
      });
      assert.deepEqual(records.dispatchRecords[0]?.value, record);
      const pickupScope = codex ? scope : pickupDispatchScope(scope);
      const readPickupRow = async () =>
        (await db.agent.read({ dispatchState: { scope: pickupScope } })).dispatchState[0]!;
      const imported = await readPickupRow();
      assert.deepEqual(imported.value.issuePickup, pickupState);
      assert.ok(!Object.hasOwn(imported.value, 'projectPickup'));

      // Reopening a row created by an earlier pilot must preserve evidence and permit import retries.
      const { issuePickup, ...header } = imported.value;
      const legacyValue = { ...header, projectPickup: issuePickup };
      await db.agent.write([
        { table: 'dispatchState', action: 'save', row: { scope: pickupScope, value: legacyValue } },
      ]);
      const retry = await importAgentStorage(options);
      assert.equal(retry.agentRows.dispatchState?.present, codex ? 1 : 2);
      const persistence = sqliteDispatchPersistence(db.agent, pickupScope);
      const journal = codex
        ? new CodexDispatchStore(dispatch, scope, persistence)
        : new OpenClawDispatchStore(intake, scope, persistence);
      assert.deepEqual((await journal.readEnvelope()).issuePickup, pickupState);
      assert.deepEqual((await readPickupRow()).value, legacyValue);
      await journal.observeIntake(async (_state, commit) => commit());
      assert.deepEqual(await readPickupRow(), imported);
      if (!codex) {
        await mkdir(workspace);
        const selected = await selectOpenClawTaskContext(
          {
            root: intake,
            resetRoot: dispatch,
            namespace: profile,
            storageBackend: 'sqlite',
            sqliteInstallation: installation,
            manifestService: {
              loadForAgentId: async () => assert.fail('unexpected manifest load'),
            },
          },
          { schemaVersion: 1, agent: { id: agentId } },
          workspace,
        );
        assert.deepEqual((await selected.dispatch(dispatch).readEnvelope()).records, [record]);
        const pickup = await selected.dispatch(intake).read();
        assert.equal(pickup.resetGeneration, 'pickup');
        assert.deepEqual(pickup.records, []);
      }
      assert.deepEqual(
        records.pickupEnrollments.map((row) => row.value),
        [enrollment],
      );
      const retirements = new DirectEntryStore(
        dispatch,
        {
          runtime,
          agentId,
          workspace,
          namespace: profile,
          session,
          incarnation: sessionId,
        },
        entriesSchema,
        'native-retirement',
        db.agent,
      );
      assert.deepEqual(await retirements.exclusive(async (entries) => entries), [receipt]);
      assert.deepEqual(records.directEntries, [
        { scope: chat, id: receipt.digest, value: receipt, kind: 'native-retirement' },
      ]);
      const unexpectedNativeCall = () =>
        assert.fail('reading ownership must not contact the scheduler');
      const threadStore = new AutomationThreads(
        { root: automations, scope: autoScope, runtime },
        {
          lookup: unexpectedNativeCall,
          create: unexpectedNativeCall,
          rename: unexpectedNativeCall,
        },
        db.agent,
      );
      assert.deepEqual((await threadStore.read()).records, [
        { key: 'job', phase: 'ready', nativeId: 'native' },
      ]);
      assert.deepEqual(
        await db.installation.readRepository(options.repositories[0]!, 'repo'),
        repo,
      );
      assert.equal((await importAgentStorage(options)).sharedRows.assignmentClaims?.present, 1);
      assert.deepEqual(await readFile(sourcePath), before);
      const replacement = {
        ...records.automationThreads[0]!,
        value: { ...records.automationThreads[0]!.value, nativeId: 'new' },
      };
      await db.agent.write([{ table: 'automationThreads', action: 'save', row: replacement }]);
      assert.equal((await threadStore.read()).records[0]?.nativeId, 'new');
      await assert.rejects(importAgentStorage(options), /destination differs/);
      const remove = {
        table: 'automationThreads',
        action: 'remove',
        key: { scope: autoScope, id: 'job' },
      } as const;
      await assert.rejects(
        db.agent.write([
          remove,
          { table: 'directEntries', action: 'insert', row: records.directEntries[0]! },
        ]),
      );
      assert.deepEqual(
        (await db.agent.read({ automationThreads: { scope: autoScope } })).automationThreads,
        [replacement],
      );
      await db.agent.write([
        { table: 'automationThreads', action: 'clearScope', scope: autoScope },
      ]);
      assert.deepEqual(await db.agent.read({ automationThreads: {} }), { automationThreads: [] });
    });
  }
});
