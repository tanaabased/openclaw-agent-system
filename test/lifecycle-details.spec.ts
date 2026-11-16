import assert from 'node:assert/strict';

import lifecycleDetails from '../cli/lifecycle-details.ts';

describe('cli/lifecycle-details', () => {
  it('should use the same scheduler identity and routing for inspection and installation', () => {
    for (const id of ['backup', 'review']) {
      const facts = {
        component: 'automations',
        stepId: id,
        automationName: `💾 Agent: ${id}`,
        automationRouting: {
          mode: 'persistent' as const,
          threadId: 'same-thread-12345678',
          outcome: 'reused',
        },
      };
      const doctor = lifecycleDetails({
        ...facts,
        status: 'healthy',
        message: `Automation ${id}: healthy (persistent, reused: same-thread-12345678).`,
      });
      const install = lifecycleDetails({
        ...facts,
        status: 'unchanged',
        message: `Automation ${id} is synchronized (reused: same-thread-12345678).`,
      });
      for (const row of [doctor, install]) {
        assert.equal(row.component, 'automation');
        assert.ok(row.message.startsWith(`name: AGENT: ${id.toUpperCase()}`));
        assert.ok(row.message.includes('mode: persistent; thread: ***5678; outcome: reused'));
        assert.equal(row.message.includes('same-thread-12345678'), false);
      }
      assert.equal(doctor.status, 'healthy');
      assert.equal(install.status, 'unchanged');
      assert.ok(install.message.includes('synchronized'));
    }
  });

  it('should render routing from fields even when service prose does not describe it', () => {
    for (const outcome of ['created', 'bound', 'reused']) {
      const raw = {
        component: 'automations',
        stepId: 'backup',
        automationName: '💾 Backup',
        automationRouting: { mode: 'persistent' as const, threadId: 'native-12345678', outcome },
        status: 'updated' as const,
        message: 'Scheduled settings were checked.',
        remediation: 'Inspect native-12345678 before retrying.',
      };
      const original = structuredClone(raw);
      const row = lifecycleDetails(raw);
      assert.ok(row.message.includes('name: BACKUP'));
      assert.ok(row.message.includes('thread: ***5678'));
      assert.ok(row.message.includes(`outcome: ${outcome}`));
      assert.ok(row.message.includes(raw.message.slice(0, -1)));
      assert.ok(row.message.includes('Inspect ***5678 before retrying.'));
      assert.equal(row.message.includes('native-12345678'), false);
      assert.deepEqual(raw, original);
    }
  });

  it('should use the id fallback for missing names and never invent a thread for command jobs', () => {
    for (const automationName of [undefined, '', '💾']) {
      const row = lifecycleDetails({
        component: 'automations',
        stepId: 'backup-drive-nightly',
        automationName,
        automationRouting: { mode: 'independent' },
        status: 'unchanged',
        message: 'Automation backup-drive-nightly is synchronized (independent).',
      });
      assert.ok(row.message.startsWith('name: BACKUP DRIVE NIGHTLY; synchronized'));
      assert.ok(row.message.includes('mode: independent'));
      assert.equal(row.message.includes('thread:'), false);
    }
  });

  it('should lead with identity and omit matching settings from healthy automation details', () => {
    const raw = {
      component: 'automations',
      stepId: 'custom-name',
      status: 'healthy' as const,
      message:
        'requested: selected / high; observed: selected / high; Automation custom-name: healthy.',
      settings: {
        requested: { model: 'selected', effort: 'high' },
        observed: { model: 'selected', effort: 'high' },
      },
    };
    const before = structuredClone(raw);
    const row = lifecycleDetails(raw);
    assert.ok(row.message.startsWith('name: CUSTOM NAME'));
    assert.equal(row.message.includes('requested'), false);
    assert.equal(row.message.includes('selected'), false);
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
      const row = lifecycleDetails(raw);
      assert.ok(row.message.startsWith('name: CUSTOM NAME'));
      assert.ok(row.message.includes(`${dimension}: requested: `));
      assert.ok(row.message.includes('observed: different'));
      assert.equal(
        row.message.includes(`${dimension === 'model' ? 'effort' : 'model'}: requested:`),
        false,
      );
      assert.equal(row.message.includes('selected /'), false);
    });

  it('should retain unsupported settings and unknown observations without inventing drift', () => {
    const row = lifecycleDetails({
      component: 'automations',
      stepId: 'custom-name',
      status: 'blocked',
      code: 'automation-effort-unsupported',
      settings: {
        requested: { model: 'native-model', effort: 'ultra' },
        observed: { model: 'native-model' },
      },
      message:
        'automation-effort-unsupported; requested: native-model / ultra; observed: native-model / native/unknown',
    });
    assert.ok(row.message.includes('effort: requested: ultra; observed: native/unknown'));
    assert.equal(row.message.includes('model: requested:'), false);
    const matching = lifecycleDetails({
      component: 'automations',
      stepId: 'custom-name',
      status: 'blocked',
      code: 'automation-model-unsupported',
      settings: { requested: { model: 'unsupported' }, observed: { model: 'unsupported' } },
      message: 'automation-model-unsupported',
    });
    assert.ok(matching.message.includes('model: requested: unsupported'));
  });

  it('should lead with known step and agent identities in both command statuses', () => {
    for (const component of ['setup', 'git']) {
      const row = lifecycleDetails({
        component,
        stepId: 'CaseSensitive',
        status: 'blocked',
        message: 'Inspection failed.',
      });
      assert.ok(row.message.startsWith('id: CaseSensitive;'));
      assert.ok(row.message.includes('Inspection failed.'));
    }
    for (const component of ['agent', 'tool-access'])
      for (const status of ['healthy', 'unchanged'] as const) {
        const row = lifecycleDetails(
          { component, status, message: 'Identity matches.' },
          'CaseSensitive',
        );
        assert.ok(row.message.startsWith('id: CaseSensitive;'));
      }
  });

  it('should not interpret literal scheduler names as replacement syntax or thread evidence', () => {
    const row = lifecycleDetails({
      component: 'automations',
      stepId: 'custom-name',
      status: 'healthy',
      automationName: '$& Backup (persistent, reused: LiteralCase1234)',
      message: 'Automation custom-name: healthy.',
    });
    assert.equal(row.message, 'name: $& BACKUP (PERSISTENT, REUSED: LITERALCASE1234).');
    assert.equal(row.message.includes('thread:'), false);
  });

  it('should retain execution failure evidence and recovery after the scheduler identity', () => {
    const row = lifecycleDetails({
      component: 'automations',
      stepId: 'github-issue-assignment',
      automationName: 'AGENT SYSTEM: GITHUB-ISSUE-ASSIGNMENT',
      status: 'blocked',
      automationRouting: {
        mode: 'persistent',
        threadId: 'native-thread-12345678',
        outcome: 'reused',
      },
      message:
        'Automation github-issue-assignment: execution-failed (last run: 2026-10-17T12:00:00Z; failure reason: auth) (persistent, reused: native-thread-12345678).',
      remediation:
        'inspect owned run history: openclaw agent-system automations runs github-issue-assignment --json.',
    });
    assert.equal(row.status, 'blocked');
    for (const signal of [
      'name: AGENT SYSTEM: GITHUB-ISSUE-ASSIGNMENT',
      'condition: execution-failed',
      '2026-10-17T12:00:00Z',
      'failure reason: auth',
      'thread: ***5678',
      'automations runs github-issue-assignment --json',
    ])
      assert.ok(row.message.includes(signal));
    assert.equal(row.message.includes('native-thread-12345678'), false);
  });

  it('should mask device and request identifiers throughout recovery commands', () => {
    const device = 'abcdef1234567890';
    const request = 'request1234567890';
    const row = lifecycleDetails({
      component: 'session-dispatch',
      status: 'blocked',
      message: `Session dispatch enrollment is incomplete. Device ${device}.`,
      remediation: `Approve request ${request} in Devices or with openclaw devices approve ${request}, then rerun Install.`,
    });
    assert.equal(row.component, 'session-dispatch-credential');
    assert.ok(row.message.startsWith('name: Agent System;'));
    assert.ok(row.message.includes('device: ***7890'));
    assert.ok(row.message.includes('devices approve ***7890'));
    assert.equal(row.message.includes(device), false);
    assert.equal(row.message.includes(request), false);
  });

  it('should preserve unrelated messages and the verified credential client name', () => {
    const raw = {
      component: 'git',
      status: 'healthy' as const,
      message: 'Git /Work/CaseSensitive OP_TOKEN.',
    };
    assert.deepEqual(lifecycleDetails(raw), raw);
    const row = lifecycleDetails({
      component: 'session-dispatch',
      status: 'healthy',
      message:
        'Session dispatch credential verified using device-only authentication. Device abcdef1234567890.',
    });
    for (const signal of ['name: Agent System', 'authentication: device-only', 'device: ***7890'])
      assert.ok(row.message.includes(signal));
    assert.equal(
      lifecycleDetails({
        component: 'github-intake',
        status: 'healthy',
        message: 'Intake baseline and policy are aligned.',
      }).component,
      'github-channel-intake',
    );
  });
});
