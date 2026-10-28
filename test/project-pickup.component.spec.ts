import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  runCodexIntake,
  selectCodexIntake,
  type CodexIntakeDependencies,
} from '../agent/codex-intake.ts';
import { bindCodexWorkspace } from '../agent/codex-workspace-binding.ts';
import issueWorkflowMode from '../agent/issue-workflow-mode.ts';
import OpenClawIntake from '../agent/openclaw-intake.ts';
import {
  projectPickupPolicyDigest,
  type ProjectPickupAuthority,
} from '../agent/project-pickup-authority.ts';
import type { IntakeRecord } from '../channels/github/intake/record-store.ts';
import parseAgentManifest from '../manifest/parse.ts';
import { baseline } from './github-intake-fixture.ts';
import { pickupDeclaration, pickupFixture } from './project-pickup-fixture.ts';

describe('project pickup native intake adapters', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'project-pickup-')));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(runtime: 'codex' | 'openclaw') {
    const f = pickupFixture(runtime);
    const workspace = join(root, 'workspace');
    const data = join(root, 'data');
    const home = join(root, 'codex');
    await mkdir(workspace);
    await mkdir(home);
    const declaration = {
      'schema-version': 1,
      agent: { id: 'receiver' },
      github: {
        username: 'receiver',
        runtimes: [runtime],
        'allowed-repository-owners': [{ login: 'owner', 'node-id': 'O_owner' }],
        'issue-assignment': {
          mode: 'plan',
          allowed: [{ login: 'operator', 'node-id': 'U_operator' }],
        },
        'project-pickup': pickupDeclaration,
      },
    };
    const source = JSON.stringify(declaration);
    await writeFile(join(workspace, 'agent.yaml'), source);
    const parsed = parseAgentManifest(source);
    assert.equal(parsed.status, 'valid');
    if (parsed.status !== 'valid') throw new Error('fixture-manifest-invalid');
    const manifest = parsed.manifest;
    let now = baseline;
    const events = f.events.splice(0);
    let run: () => Promise<unknown>;
    let read: () => Promise<IntakeRecord[]>;
    let setAuthority: (authority: ProjectPickupAuthority) => void;
    let scope: string;
    if (runtime === 'codex') {
      await bindCodexWorkspace(data, workspace);
      const deps: CodexIntakeDependencies = {
        codexHome: home,
        now: () => now,
        assertActive: async () => {},
        connect: async () => f.client,
      };
      await runCodexIntake(data, true, deps);
      const selected = await selectCodexIntake(data, deps);
      scope = selected.store.location.scope;
      run = () => runCodexIntake(data, false, deps);
      read = async () => (await selected.store.read())!.records;
      setAuthority = (authority) => {
        deps.projectPickup = authority;
      };
    } else {
      const service = new OpenClawIntake({
        root: data,
        namespace: root,
        now: () => now,
        connect: async () => f.client,
        readiness: async () => undefined,
        manifestService: {
          loadForAgentId: async () => ({
            status: 'loaded',
            manifest,
            scope: { workspaceDir: workspace, agentId: 'receiver' },
            path: join(workspace, 'agent.yaml'),
            digest: 'fixture',
            diagnostics: [],
            validationChecks: [],
          }),
        },
      });
      await service.run(manifest, workspace, 'activate');
      const selected = await service.select(manifest, workspace);
      scope = selected.store.location.scope;
      run = () => service.run(manifest, workspace, 'scan');
      read = async () => (await selected.store.read())!.records;
      setAuthority = (authority) => {
        service.dependencies.projectPickup = authority;
      };
    }
    f.authority.enrollment.scope = scope;
    f.authority.enrollment.workspaceDir = workspace;
    f.authority.enrollment.policyDigest = projectPickupPolicyDigest(
      manifest.github!.notifications!,
    );
    now += 7200000;
    f.events.push(...events);
    return { ...f, run, read, setAuthority, manifest };
  }

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should admit only verified delayed self-assignment through ${runtime}`, async () => {
      const f = await fixture(runtime);
      await f.run();
      assert.equal(
        (await f.read()).length,
        0,
        'configuration alone cannot approve self-assignment',
      );
      f.setAuthority(f.authority);
      await f.run();
      const records = await f.read();
      assert.equal(records.length, 1);
      assert.equal(records[0]!.evidence.mode, 'work');
      assert.equal(records[0]!.evidence.projectWork!.pickup!.assignmentNodeId, f.events[0]!.nodeId);
      await f.run();
      assert.equal((await f.read()).length, 1, 'repeated scan must not duplicate admission');
    });

    it(`should leave already admitted plan work held after enrollment in ${runtime}`, async () => {
      const f = await fixture(runtime);
      f.events[0]!.actor = { login: 'operator', nodeId: 'U_operator', type: 'User' };
      await f.run();
      const before = await f.read();
      assert.equal(before[0]!.evidence.mode, 'plan');
      f.authority.receipts = [];
      f.setAuthority(f.authority);
      await f.run();
      assert.deepEqual(await f.read(), before);
      assert.equal(issueWorkflowMode(f.manifest.github!.notifications, {}), 'plan');
    });
  }
});
