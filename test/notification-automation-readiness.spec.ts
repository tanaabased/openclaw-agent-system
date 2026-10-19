import assert from 'node:assert/strict';

import type { AutomationGateway } from '../agent/automation-gateway.ts';
import notificationAutomationReadiness, {
  type NotificationScheduler,
} from '../agent/automation-readiness.ts';
import {
  effectiveAutomation,
  nativeAutomationHash,
  projectAutomation,
} from '../agent/automation-projection.ts';
import AutomationStore, { type AutomationRecord } from '../agent/automation-store.ts';
import openclawIntakeJobs from '../agent/openclaw-intake-policy.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { intakeFixture } from './github-intake-fixture.ts';

function fixture() {
  const manifest: AgentManifest = {
    schemaVersion: 1,
    agent: { id: 'receiver' },
    models: { default: { model: 'openai/gpt-6-luna', effort: 'medium' } },
    github: {
      username: 'receiver',
      notifications: { ...intakeFixture().policy, runtimes: ['openclaw', 'codex'] },
    },
  };
  const context = {
    agentId: 'receiver',
    workspaceDir: '/workspace',
    command: ['node', 'openclaw'],
    environment: {},
    timezone: 'UTC',
  };
  const store = new AutomationStore({
    root: '/unused',
    profile: '/profile',
    agentId: 'receiver',
    workspaceDir: '/workspace',
  });
  const job = openclawIntakeJobs(manifest)[0]!;
  const record: AutomationRecord = {
    id: job.id,
    marker: store.marker(job.id),
    nativeId: 'native',
    hash: effectiveAutomation(job, context).hash,
    triggerHash: 'a'.repeat(64),
    generation: 1,
    anchorMs: 10,
    removed: false,
  };
  const native = {
    ...projectAutomation(job, record, context),
    id: 'native',
    state: { lastRunStatus: 'ok', lastDeliveryStatus: 'not-requested' },
  } as Awaited<ReturnType<NotificationScheduler['list']>>[number] & {
    state: { lastRunStatus: string; lastDeliveryStatus: string };
  };
  record.nativeHash = nativeAutomationHash(native);
  const records = [record];
  store.read = async () => ({ version: 1, scope: store.scope, records });
  const scheduler: NotificationScheduler = {
    async isEnabled() {
      return true;
    },
    async list() {
      return [native];
    },
  };
  const service = {
    async scope() {
      return { context, store };
    },
  };
  return {
    manifest,
    record,
    records,
    native,
    scheduler,
    read: (reader: NotificationScheduler | undefined = scheduler) =>
      notificationAutomationReadiness(service, manifest, '/workspace', reader),
    readOperator: (request: AutomationGateway) =>
      notificationAutomationReadiness(service, manifest, '/workspace', undefined, request),
    unavailable: () => notificationAutomationReadiness(service, manifest, '/workspace'),
  };
}

describe('notification automation readiness', () => {
  it('should apply live policy without scheduler drift and still detect changed native machinery', async () => {
    const f = fixture();
    assert.equal(await f.read(), undefined);
    const workflow = f.manifest.github!.notifications!.issueAssignment!;
    workflow.allowed[0] = { ...workflow.allowed[0]!, nodeId: 'foreign' };
    assert.equal(await f.read(), undefined);
    workflow.allowed[0] = { ...workflow.allowed[0]!, nodeId: 'U_receiver' };
    f.native.payload = { ...f.native.payload, text: 'changed consent' };
    assert.equal(await f.read(), 'intake-automation-update-required');
  });
  it('should reject malformed scheduler observations instead of inventing an empty scan', async () => {
    const f = fixture();
    for (const jobs of [undefined, {}, [null], [{ agentId: 'receiver' }]]) {
      assert.equal(
        await f.read({ ...f.scheduler, list: async () => jobs as never }),
        'automation-observation-unavailable',
      );
    }
  });

  it('should compare desired, saved and native projections without requiring session access', async () => {
    const f = fixture();
    const methods: string[] = [];
    const request: AutomationGateway = async (method) => {
      methods.push(method);
      if (method === 'cron.status') return { enabled: true };
      assert.equal(method, 'cron.list');
      return { jobs: [{ ...f.native, configRevision: '1' }], hasMore: false };
    };
    assert.equal(await f.read(), undefined);
    assert.equal(await f.readOperator(request), undefined);
    assert.deepEqual(methods, ['cron.status', 'cron.list']);
    assert.equal(
      await f.readOperator(async () => ({ enabled: false })),
      'automation-scheduler-disabled',
    );
    assert.equal(await f.readOperator(async () => ({})), 'automation-observation-unavailable');
    f.manifest.models!.default!.effort = 'high';
    assert.equal(await f.read(), 'intake-automation-update-required');
    assert.equal(await f.readOperator(request), 'intake-automation-update-required');
  });

  it('should report missing, changed, disabled and uncertain projections', async () => {
    const f = fixture();
    f.records.length = 0;
    assert.equal(await f.read(), 'intake-activation-required');
    f.records.push(f.record);
    f.record.pending = { kind: 'update', nativeHash: 'a'.repeat(64) };
    assert.equal(await f.read(), 'intake-automation-update-required');
    delete f.record.pending;
    assert.equal(
      await f.read({
        ...f.scheduler,
        async list() {
          return [];
        },
      }),
      'intake-automation-update-required',
    );
    f.native.enabled = false;
    assert.equal(await f.read(), 'intake-automation-update-required');
  });

  it('should require an available scheduler without blocking recovery after earlier run or delivery failures', async () => {
    const f = fixture();
    assert.equal(await f.unavailable(), 'automation-observation-unavailable');
    assert.equal(await f.read({ list: f.scheduler.list }), 'automation-observation-unavailable');
    assert.equal(
      await f.read({
        ...f.scheduler,
        async isEnabled() {
          return false;
        },
      }),
      'automation-scheduler-disabled',
    );
    f.native.state.lastRunStatus = 'error';
    assert.equal(await f.read(), undefined);
    f.native.state.lastRunStatus = 'ok';
    f.native.state.lastDeliveryStatus = 'not-delivered';
    assert.equal(await f.read(), undefined);
  });

  it('should refuse ambiguous or differently owned native jobs', async () => {
    const f = fixture();
    assert.equal(
      await f.read({
        ...f.scheduler,
        async list() {
          return [f.native, { ...f.native, id: 'duplicate' }];
        },
      }),
      'automation-ownership-conflict',
    );
    f.native.agentId = 'other';
    assert.equal(await f.read(), 'automation-ownership-conflict');
  });
});
