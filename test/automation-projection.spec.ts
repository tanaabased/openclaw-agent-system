import assert from 'node:assert/strict';

import {
  automationPatch,
  effectiveAutomation,
  nativeAutomationHash,
  projectAutomation,
  type AutomationProjectionContext,
} from '../agent/automation-projection.ts';
import type { NativeAutomation } from '../agent/automation-gateway.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';
import normalizeSchedule from '../manifest/automation-schedule.ts';

const context: AutomationProjectionContext = {
  agentId: 'tanaabot',
  workspaceDir: '/workspace/agent',
  command: ['/usr/bin/node', '/usr/bin/openclaw'],
  environment: { OPENCLAW_STATE_DIR: '/profile' },
  timezone: 'UTC',
};

function job(payload: { prompt: string } | { run: string[] }) {
  const parsed = normalizeAutomations([{ id: 'review', schedule: 'every 1 hour', ...payload }]);
  if (parsed.status !== 'valid') throw new Error('invalid fixture');
  return parsed.automations[0]! as ResolvedAutomation;
}

describe('agent/automation-projection', () => {
  it('should patch only presentation when labels are added, renamed or removed', () => {
    const record = {
      id: 'review',
      marker: 'fixture',
      hash: '',
      triggerHash: '',
      generation: 1,
      anchorMs: 0,
      removed: false,
    };
    for (const original of [job({ prompt: 'Review.' }), job({ run: ['node', 'task.js'] })]) {
      const unlabeled = projectAutomation(original, record, context);
      assert.equal(unlabeled.name, 'Agent System: review');
      assert.equal(Object.hasOwn(unlabeled, 'displayName'), false);
      const nativeFields = {
        id: 'native-review',
        declarationKey: record.marker,
        agentId: context.agentId,
        configRevision: '1',
        state: {},
      };
      let current: NativeAutomation = { ...unlabeled, ...nativeFields };
      for (const label of ['🔄 NIGHTLY REFRESH', '🔄 RENAMED', undefined]) {
        const changed = { ...original, displayName: label };
        const desired = projectAutomation(changed, record, context);
        assert.deepEqual(automationPatch(current, desired), {
          displayName: label ?? null,
        });
        assert.notEqual(nativeAutomationHash(current), nativeAutomationHash(desired));
        assert.deepEqual(
          effectiveAutomation(changed, context),
          effectiveAutomation(original, context),
        );
        const { displayName, ...withoutLabel } = desired;
        assert.equal(displayName, label);
        assert.deepEqual(withoutLabel, unlabeled);
        current = { ...desired, ...nativeFields };
      }
      assert.equal(
        nativeAutomationHash({ ...unlabeled, displayName: null }),
        nativeAutomationHash(unlabeled),
      );
      assert.deepEqual(
        automationPatch({ ...unlabeled, ...nativeFields, displayName: null }, unlabeled),
        {},
      );
      assert.deepEqual(automationPatch(current, current), {});
    }
  });

  it('should inherit capture for new commands and migrate retained overrides in place', () => {
    const record = {
      id: 'review',
      marker: 'fixture',
      hash: '',
      triggerHash: '',
      generation: 1,
      anchorMs: 0,
      removed: false,
    };
    const desired = projectAutomation(job({ run: ['node', 'task.js'] }), record, context);
    assert.equal(Object.hasOwn(desired.payload, 'outputMaxBytes'), false);
    const current = {
      ...desired,
      id: 'native',
      configRevision: '1',
      declarationKey: 'fixture',
      agentId: context.agentId,
      state: {},
    };
    assert.deepEqual(automationPatch(current, desired), {});
    for (const outputMaxBytes of [16384, 12345, 16777216]) {
      const limited = { ...current, payload: { ...current.payload, outputMaxBytes } };
      const original = structuredClone(limited);
      const migrated = projectAutomation(
        job({ run: ['node', 'task.js'] }),
        record,
        context,
        limited,
      );
      assert.equal(migrated.payload.outputMaxBytes, 16777216);
      assert.deepEqual(
        automationPatch(limited, migrated),
        outputMaxBytes === 16777216 ? {} : { payload: { ...migrated.payload, toolsAllow: null } },
      );
      assert.deepEqual(limited, original);
    }
  });

  it('should project omitted and null zones locally and preserve explicit zones', () => {
    const record = {
      id: 'review',
      marker: 'fixture',
      hash: '',
      triggerHash: '',
      generation: 1,
      anchorMs: 0,
      removed: false,
    };
    for (const [declaration, timezone] of [
      ['0 8 * * *', 'UTC'],
      [{ cron: '0 8 * * *' }, 'UTC'],
      [{ cron: '0 8 * * *', timezone: null }, 'UTC'],
      [{ cron: '0 8 * * *', timezone: 'America/New_York' }, 'America/New_York'],
    ] as const) {
      const scheduled = {
        ...job({ prompt: 'Review activity.' }),
        schedule: normalizeSchedule(declaration),
      };
      assert.equal(projectAutomation(scheduled, record, context).schedule.tz, timezone);
    }
  });
  it('should preserve stepped days and their wildcard semantics in native cron schedules', () => {
    const record = {
      id: 'review',
      marker: 'fixture',
      hash: '',
      triggerHash: '',
      generation: 1,
      anchorMs: 0,
      removed: false,
    };
    for (const expression of [
      '0 8 */2 * *',
      '0 8 * * */2',
      '0 8 */2 * 1',
      '0 8 1 * */2',
      '0 8 */2,2 * 1',
      '0 8 1-31/2 * 1',
    ]) {
      const schedule = normalizeSchedule(expression);
      const native = projectAutomation(
        { ...job({ prompt: 'Review activity.' }), schedule },
        record,
        context,
      );
      assert.deepEqual(normalizeSchedule(native.schedule.expr), schedule, expression);
    }
  });

  it('should keep prompt fingerprints stable across cli and gateway launcher contexts', () => {
    const prompt = job({ prompt: 'Review activity.' });
    const original = structuredClone(context);
    const gateway = {
      ...context,
      command: ['/opt/node/bin/node', '/opt/openclaw/dist/index.js'],
      environment: {},
    };
    assert.equal(
      effectiveAutomation(prompt, context).hash,
      effectiveAutomation(prompt, gateway).hash,
    );
    assert.deepEqual(context, original);
  });

  it('should retain command launcher and environment drift checks', () => {
    const command = job({ run: ['node', 'task.js'] });
    const original = effectiveAutomation(command, context).hash;
    for (const changed of [
      { ...context, command: ['/usr/bin/node', '/opt/openclaw/dist/index.js'] },
      { ...context, environment: {} },
    ])
      assert.notEqual(effectiveAutomation(command, changed).hash, original);
  });

  it('should retain prompt identity and execution settings in the fingerprint', () => {
    const prompt = job({ prompt: 'Review activity.' });
    const original = effectiveAutomation(prompt, context).hash;
    for (const changed of [
      { ...context, agentId: 'other' },
      { ...context, workspaceDir: '/workspace/other' },
      { ...context, timezone: 'America/New_York' },
    ])
      assert.notEqual(effectiveAutomation(prompt, changed).hash, original);
    for (const changed of [
      { ...prompt, payload: { kind: 'prompt' as const, prompt: 'Changed task.' } },
      { ...prompt, overrides: { openclaw: { model: 'provider/other', effort: 'high' as const } } },
      {
        ...prompt,
        internalOpenClaw: { trigger: { script: 'json({fire:false})' }, toolsAllow: ['read'] },
      },
    ])
      assert.notEqual(effectiveAutomation(changed, context).hash, original);
  });
});
