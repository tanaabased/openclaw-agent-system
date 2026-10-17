import assert from 'node:assert/strict';

import {
  effectiveAutomation,
  type AutomationProjectionContext,
} from '../agent/automation-projection.ts';
import normalizeAutomations, { type ResolvedAutomation } from '../manifest/automation-schema.ts';

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
