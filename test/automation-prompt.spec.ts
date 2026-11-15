import assert from 'node:assert/strict';

import { resolveAutomationPrompt } from '../agent/automations/automation-prompt.ts';
import {
  effectiveAutomation,
  nativeAutomationHash,
  projectAutomation,
} from '../agent/automations/automation-projection.ts';
import openclawIntakeJobs from '../agent/automations/openclaw-intake-policy.ts';
import { codexIntakeJobs } from '../agent/automations/codex-intake-policy.ts';
import type { AgentManifest } from '../manifest/types.ts';
import { pickupFixture } from './issue-pickup-fixture.ts';

describe('agent/automation-prompt', () => {
  it('should resolve the complete assignment and pickup instructions without compacting standalone codex', async () => {
    const { policy } = pickupFixture('openclaw');
    const manifest: AgentManifest = {
      schemaVersion: 1,
      agent: { id: 'receiver' },
      models: {
        default: { model: 'openai/test', effort: 'medium' },
      },
      github: { username: 'receiver', notifications: policy },
    };
    const context = {
      agentId: 'receiver',
      workspaceDir: '/workspace',
      command: [],
      environment: {},
      timezone: 'UTC',
    };
    const jobs = openclawIntakeJobs(manifest);
    for (const id of ['github-issue-assignment', 'github-issue-pickup']) {
      const job = jobs.find((entry) => entry.id === id)!;
      assert.ok(job);
      assert.equal(job.payload.kind, 'prompt');
      const record = {
        id: job.id,
        marker: `agent-system:scope:${job.id}`,
        nativeId: `native-${job.id}`,
        hash: effectiveAutomation(job, context).hash,
        triggerHash: 'trigger',
        generation: 1,
        anchorMs: 0,
        removed: false,
        nativeHash: '',
      };
      const native = { ...projectAutomation(job, record, context), id: record.nativeId };
      record.nativeHash = nativeAutomationHash(native);
      const service = {
        scope: async () => ({ context, store: { read: async () => ({ records: [record] }) } }),
      } as never;
      const result = await resolveAutomationPrompt(
        service,
        { list: async () => [native] } as never,
        manifest,
        {
          ...context,
          jobId: record.nativeId,
          runId: 'run',
          sessionKey: 'agent:receiver:scheduled',
          sessionId: 'session',
        },
      );
      assert.deepEqual(result, {
        prompt: job.payload.kind === 'prompt' ? job.payload.prompt : undefined,
      });
      assert.ok(result.prompt!.length > String(native.payload.message).length);
      assert.ok(!String(native.payload.message).includes('agent_system_'));
    }
    const portable = structuredClone(manifest);
    portable.github!.notifications!.runtimes = ['codex'];
    portable.github!.notifications!.issueAssignment!.model = 'default';
    for (const id of ['github-issue-assignment', 'github-issue-pickup']) {
      const job = codexIntakeJobs(portable).find((entry) => entry.id === id)!;
      assert.equal(job.payload.kind, 'prompt');
      assert.match(job.payload.kind === 'prompt' ? job.payload.prompt : '', /runtimeRoute/);
      assert.doesNotMatch(
        job.payload.kind === 'prompt' ? job.payload.prompt : '',
        /Scheduled request/,
      );
    }
  });
});
