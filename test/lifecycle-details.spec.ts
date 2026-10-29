import assert from 'node:assert/strict';

import lifecycleDetails from '../cli/lifecycle-details.ts';
import type { AgentManifest } from '../manifest/types.ts';

const automations: NonNullable<AgentManifest['automations']> = [
  {
    id: 'custom-name',
    enabled: true,
    runtimes: ['openclaw'],
    schedule: { kind: 'every', seconds: 60, missedRun: 'native' },
    payload: { kind: 'prompt', prompt: 'check' },
    overrides: {},
    thread: { name: 'MixedCase Backup /OP_TOKEN' },
  },
];

describe('cli/lifecycle-details', () => {
  it('should lead with identity and omit matching settings from healthy automation details', () => {
    const raw = {
      component: 'automations',
      stepId: 'custom-name',
      status: 'healthy' as const,
      message:
        'requested: selected / high; observed: selected / high; Automation custom-name: healthy (persistent, reused: native-12345678).',
      settings: {
        requested: { model: 'selected', effort: 'high' },
        observed: { model: 'selected', effort: 'high' },
      },
    };
    const before = structuredClone(raw);
    const row = lifecycleDetails(raw, automations);
    assert.ok(row.message.startsWith('name: MixedCase Backup /OP_TOKEN'));
    assert.equal(row.message.includes('requested'), false);
    assert.equal(row.message.includes('selected'), false);
    assert.ok(row.message.includes('thread: ***5678'));
    assert.deepEqual(raw, before);
  });

  for (const dimension of ['model', 'effort'] as const)
    it(`should show only ${dimension} drift after the automation identity`, () => {
      const raw = {
        component: 'automations',
        stepId: 'custom-name',
        status: 'blocked' as const,
        code: 'automation-thread-model-drift',
        message: `automation-thread-model-drift; requested: selected / high; observed: ${dimension === 'model' ? 'different / high' : 'selected / different'}`,
        settings: {
          requested: { model: 'selected', effort: 'high' },
          observed: { model: 'selected', effort: 'high', [dimension]: 'different' },
        },
      };
      const row = lifecycleDetails(raw, automations);
      assert.ok(row.message.startsWith('name: MixedCase Backup /OP_TOKEN'));
      assert.ok(row.message.includes(`${dimension}: requested: `));
      assert.ok(row.message.includes('observed: different'));
      assert.equal(
        row.message.includes(`${dimension === 'model' ? 'effort' : 'model'}: requested:`),
        false,
      );
      assert.equal(row.message.includes('selected /'), false);
    });

  it('should retain actionable unsupported settings and unknown observations without inventing drift', () => {
    const settings = {
      requested: { model: 'native-model', effort: 'ultra' },
      observed: { model: 'native-model' },
    };
    const row = lifecycleDetails(
      {
        component: 'automations',
        stepId: 'custom-name',
        status: 'blocked',
        code: 'automation-effort-unsupported',
        settings,
        message:
          'automation-effort-unsupported; requested: native-model / ultra; observed: native-model / native/unknown',
      },
      automations,
    );
    assert.ok(row.message.startsWith('name: MixedCase Backup /OP_TOKEN'));
    assert.ok(row.message.includes('effort: requested: ultra; observed: native/unknown'));
    assert.equal(row.message.includes('model: requested:'), false);
    const matching = lifecycleDetails(
      {
        component: 'automations',
        stepId: 'custom-name',
        status: 'blocked',
        code: 'automation-model-unsupported',
        settings: { requested: { model: 'unsupported' }, observed: { model: 'unsupported' } },
        message: 'automation-model-unsupported',
      },
      automations,
    );
    assert.ok(matching.message.includes('model: requested: unsupported'));
  });

  it('should lead with known step, resource, agent, and credential identities without changing evidence', () => {
    for (const component of ['setup', 'git']) {
      const row = lifecycleDetails(
        { component, stepId: 'CaseSensitive', status: 'blocked', message: 'Inspection failed.' },
        [],
      );
      assert.ok(row.message.startsWith('id: CaseSensitive;'));
      assert.ok(row.message.includes('Inspection failed.'));
    }
    const agent = lifecycleDetails(
      {
        component: 'agent',
        status: 'healthy',
        message: 'OpenClaw identity for CaseSensitive matches.',
      },
      [],
      'CaseSensitive',
    );
    assert.ok(agent.message.startsWith('id: CaseSensitive;'));
    const credential = lifecycleDetails(
      {
        component: 'session-dispatch',
        status: 'blocked',
        message: 'Session dispatch enrollment is incomplete. Device abcdef1234567890.',
      },
      [],
    );
    assert.ok(credential.message.startsWith('name: Agent System;'));
    assert.ok(credential.message.includes('device: ***7890'));
  });

  it('should keep categories stable and names literal without redundant declaration ids', () => {
    const original = {
      component: 'automations',
      stepId: 'custom-name',
      status: 'healthy' as const,
      message:
        'Automation custom-name: healthy (persistent, reused: agent:data:automation:abcdef123456).',
    };
    const copy = structuredClone(original);
    const row = lifecycleDetails(original, automations);
    assert.equal(row.component, 'automation');
    assert.equal(row.status, 'healthy');
    assert.ok(row.message.includes('name: MixedCase Backup /OP_TOKEN'));
    assert.ok(row.message.includes('thread: ***3456'));
    assert.ok(row.message.includes('outcome: reused'));
    assert.equal(row.message.includes('custom-name'), false);
    assert.equal(row.message.includes('"'), false);
    assert.equal(row.message.includes('healthy'), false);
    assert.equal(row.message.includes('abcdef123456'), false);
    assert.deepEqual(original, copy);
  });

  it('should not interpret literal names as replacement syntax or thread evidence', () => {
    const name = '$& Backup (persistent, reused: LiteralCase1234)';
    const jobs = [{ ...automations[0]!, thread: { name } }];
    const row = lifecycleDetails(
      {
        component: 'automations',
        stepId: 'custom-name',
        status: 'healthy',
        message: 'Automation custom-name: healthy.',
      },
      jobs,
    );
    assert.equal(row.message, `name: ${name}.`);
  });

  it('should name command jobs descriptively without inventing a thread', () => {
    const row = lifecycleDetails(
      {
        component: 'automations',
        stepId: 'backup-drive-nightly',
        status: 'healthy',
        message: 'Automation backup-drive-nightly: healthy.',
      },
      [],
    );
    assert.equal(row.message, 'name: BACKUP DRIVE NIGHTLY.');
    assert.equal(row.message.includes('thread:'), false);
  });

  it('should use the native intake name and retain execution failure evidence', () => {
    const row = lifecycleDetails(
      {
        component: 'automations',
        stepId: 'github-issue-assignment',
        status: 'blocked',
        message:
          'Automation github-issue-assignment: execution-failed (last run: 2026-10-17T12:00:00Z; failure reason: auth) (persistent, reused: native-thread-12345678).',
        remediation:
          'inspect owned run history: openclaw agent-system automations runs github-issue-assignment --json.',
      },
      [],
    );
    assert.equal(row.status, 'blocked');
    for (const signal of [
      'name: ISSUE ASSIGNMENTS',
      'condition: execution-failed',
      '2026-10-17T12:00:00Z',
      'failure reason: auth',
      'thread: ***5678',
      'automations runs github-issue-assignment --json',
    ])
      assert.ok(row.message.includes(signal));
  });

  it('should mask devices and pending requests throughout recovery commands', () => {
    const device = 'abcdef1234567890';
    const request = 'request1234567890';
    const row = lifecycleDetails(
      {
        component: 'session-dispatch',
        status: 'blocked',
        message: `Session dispatch enrollment is incomplete. Device ${device}.`,
        remediation: `Approve request ${request} in Devices or with openclaw devices approve ${request}, then rerun Install.`,
      },
      [],
    );
    assert.equal(row.component, 'session-dispatch-credential');
    assert.ok(row.message.includes('device: ***7890'));
    assert.ok(row.message.includes('devices approve ***7890'));
    assert.equal(row.message.includes(device), false);
    assert.equal(row.message.includes(request), false);
  });

  it('should retain thread identifiers safely in every install routing outcome', () => {
    for (const outcome of ['created', 'bound', 'reused']) {
      const row = lifecycleDetails(
        {
          component: 'automations',
          stepId: 'custom-name',
          status: 'unchanged',
          message: `Automation custom-name is synchronized (${outcome}: native-12345678).`,
        },
        automations,
      );
      assert.equal(row.component, 'automation');
      assert.ok(row.message.includes('thread: ***5678'));
      assert.ok(row.message.includes(`outcome: ${outcome}`));
      assert.equal(row.message.includes('native-12345678'), false);
    }
  });

  it('should preserve unrelated messages and show the verified credential client name', () => {
    const raw = {
      component: 'git',
      status: 'healthy' as const,
      message: 'Git /Work/CaseSensitive OP_TOKEN.',
    };
    assert.deepEqual(lifecycleDetails(raw, []), raw);
    const row = lifecycleDetails(
      {
        component: 'session-dispatch',
        status: 'healthy',
        message:
          'Session dispatch credential verified using device-only authentication. Device abcdef1234567890.',
      },
      [],
    );
    assert.ok(row.message.includes('name: Agent System'));
    assert.ok(row.message.includes('authentication: device-only'));
    assert.ok(row.message.includes('device: ***7890'));
    assert.equal(
      lifecycleDetails(
        {
          component: 'github-intake',
          status: 'healthy',
          message: 'Intake baseline and policy are aligned.',
        },
        [],
      ).component,
      'github-channel-intake',
    );
  });
});
