import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { automationHash } from '../agent/automation-hash.ts';
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
      await save(join(dispatch, runtime + '-dispatch-' + scope + '.json'), {
        version: 4,
        scope,
        resetGeneration: 'saved',
        records: [record],
      });
      if (!codex)
        await save(join(intake, runtime + '-dispatch-' + scope + '.json'), {
          version: 4,
          scope,
          resetGeneration: 'pickup',
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
      await save(
        join(automations, (codex ? 'codex-automations-' : 'automations-') + autoScope + '.json'),
        {
          version: 1,
          scope: autoScope,
          records: [],
          ...(codex && { retired: [], binding: { agentId, workspace, codexHome: profile } }),
        },
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
      const preview = await importAgentStorage(options);
      assert.equal(preview.agentRows.pickupEnrollments?.insert, 1);
      assert.deepEqual(preview.unselectedSessionScopes, [orphan]);
      assert.equal(await db.agent.readIntake(scope), undefined);
      options.apply = true;
      await importAgentStorage(options);
      assert.deepEqual(await db.agent.readIntake(scope), checkpoint);
      const records = await db.agent.read({
        dispatchRecords: { scope },
        directEntries: {},
        pickupEnrollments: {},
        automationState: {},
        automationThreads: {},
      });
      assert.deepEqual(records.dispatchRecords[0]?.value, record);
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
      assert.deepEqual(records.directEntries, [
        { scope: chat, id: receipt.digest, value: receipt, kind: 'native-retirement' },
      ]);
      assert.equal(records.automationThreads[0]?.value.nativeId, 'native');
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
