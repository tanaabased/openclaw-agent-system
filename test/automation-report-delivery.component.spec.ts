import assert from 'node:assert/strict';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';

import deliverAutomationReport, {
  reconcileAutomationReport,
} from '../agent/automation-report-delivery.ts';
import AutomationReportStore from '../agent/automation-report-store.ts';
import type { AutomationReportInput } from '../agent/automation-report.ts';
import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import registerAutomationReportHooks from '../core/automation-report-hook.ts';

const input: AutomationReportInput = {
  id: 'backup',
  executionId: randomUUID(),
  startedAt: '2026-10-30T00:00:00Z',
  cancelled: false,
  result: {
    exitCode: 17,
    timedOut: false,
    truncated: false,
    output: { stdout: '# Saved\n', stderr: 'failed' },
  },
};
describe('agent/automation-report-delivery', () => {
  let workspaceDir: string;
  beforeEach(async () => {
    workspaceDir = await realpath(await mkdtemp('/tmp/report-delivery-'));
  });
  afterEach(async () => {
    await rm(workspaceDir, { recursive: true, force: true });
  });
  function fixture(
    options: {
      lostAck?: boolean;
      archived?: boolean;
      otherWorkspace?: boolean;
      revoked?: boolean;
      stale?: boolean;
      malformed?: boolean;
      pending?: boolean;
      drift?: boolean;
      badCard?: boolean;
      denied?: boolean;
      hookDenied?: boolean;
      settledBeforeAck?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
    const messages: string[] = [];
    const replies: unknown[] = [];
    const store = new AutomationReportStore(`${workspaceDir}/reports`);
    type HookResult =
      { toolsAllow?: string[]; block?: boolean; retry?: { maxAttempts?: number } } | undefined;
    type Hook = (
      event: Record<string, unknown>,
      context: Record<string, unknown>,
    ) => Promise<HookResult>;
    const hooks = new Map<string, Hook>();
    registerAutomationReportHooks(
      {
        on: (name: string, fn: Hook) => {
          hooks.set(name, fn);
        },
      } as never,
      store,
      async () => {},
    );
    const target = {
      sessionKey: 'agent:a:reports',
      agentId: 'a',
      workspaceDir,
      scope: 'fixture',
      model: 'test/formatter',
      effort: 'high',
    };
    async function assertCurrent() {
      if (options.stale) throw Error('stale');
    }
    const credential: Pick<SessionDispatchCredential, 'use'> = {
      async use(authority, operation) {
        assert.equal(authority.signal?.aborted, false);
        await authority.assertCurrent?.();
        if (options.revoked) throw Error('revoked');
        return operation(async (method: string, params: Record<string, unknown>) => {
          calls.push(method);
          if (method === 'plugins.inspect')
            return {
              plugin: { id: 'agent-system', enabled: true },
              grants: {
                hooks: {
                  allowConversationAccess: { effective: !options.hookDenied },
                  allowPromptInjection: { effective: true },
                },
              },
            };
          if (method === 'sessions.resolve')
            return { ok: true, key: target.sessionKey, agentId: 'a' };
          if (method === 'sessions.list')
            return {
              sessions: [
                {
                  key: target.sessionKey,
                  sessionId: 'incarnation',
                  workspaceDir: options.otherWorkspace ? '/' : workspaceDir,
                  archived: options.archived,
                  model: options.drift ? 'test/other' : target.model,
                  thinkingLevel: target.effort,
                },
              ],
            };
          if (method === 'chat.history') return { sessionId: 'incarnation', messages: replies };
          if (method === 'agent.wait') return { runId: params.runId, status: 'timeout' };
          assert.equal(method, 'chat.send');
          assert.equal(params.sessionKey, target.sessionKey);
          assert.equal(params.sessionId, 'incarnation');
          assert.equal(params.thinking, 'high');
          assert.equal(params.queueMode, 'followup');
          messages.push(String(params.message));
          if (options.lostAck) throw Error('lost acknowledgment');
          if (options.denied)
            throw new GatewayClientRequestError({
              code: 'FORBIDDEN',
              message: 'private diagnostic',
            });
          const context = {
            agentId: 'a',
            sessionKey: target.sessionKey,
            sessionId: 'incarnation',
            runId: params.idempotencyKey,
          };
          const guard = await hooks.get('before_prompt_build')!({}, context);
          assert.deepEqual(guard?.toolsAllow, []);
          assert.equal(
            (await hooks.get('before_tool_call')!({ toolName: 'exec' }, context))?.block,
            true,
          );
          await hooks.get('llm_output')!(
            {
              runId: params.idempotencyKey,
              provider: 'test',
              model: 'formatter',
              reasoningEffort: 'high',
            },
            context,
          );
          const record = await store.read(String(params.idempotencyKey));
          const body = `> ## ${options.badCard ? '✅' : '❌'} Backup failed\n>\n> ${record!.input.runLine}\n>\n> The command exited unsuccessfully.`;
          const validation = await hooks.get('before_agent_finalize')!(
            { lastAssistantMessage: body },
            context,
          );
          if (options.badCard) assert.equal(validation?.retry?.maxAttempts, 1);
          else assert.equal(validation, undefined);
          if (!options.pending)
            replies.push({
              role: 'assistant',
              stopReason: 'stop',
              content: [{ type: 'text', text: body }],
              __openclaw: {
                id: `reply-${params.idempotencyKey}`,
                runId: params.idempotencyKey,
                runTerminal: true,
              },
            });
          if (options.settledBeforeAck) {
            await store.update(String(params.idempotencyKey), (current) => {
              current.state = 'delivered';
              current.messageId = `reply-${params.idempotencyKey}`;
            });
            throw Error('acknowledgment lost after terminal hook');
          }
          return options.malformed ? {} : { status: 'started', runId: params.idempotencyKey };
        });
      },
    };
    const deliver = (executionId = input.executionId) =>
      deliverAutomationReport({
        target,
        input: { ...input, executionId },
        store,
        hash: 'hash',
        manifestDigest: 'manifest',
        credential,
        assertCurrent,
      });
    const recover = (executionId = input.executionId) =>
      reconcileAutomationReport({ store, executionId, credential, assertCurrent });
    return { deliver, recover, calls, messages, store, hooks };
  }
  it('should verify final cards and settings while preserving unrelated chat tools', async () => {
    const f = fixture();
    const results = await Promise.all([f.deliver(), f.deliver(randomUUID())]);
    assert.deepEqual(
      results.map((result) => result.status),
      ['delivered', 'delivered'],
    );
    assert.equal(f.messages.length, 2);
    assert.ok(f.messages[0]!.includes('Exit 17'));
    assert.ok(f.messages[0]!.includes('# Saved'));
    const saved = await f.store.read(input.executionId);
    assert.deepEqual(saved?.effective, { model: 'test/formatter', effort: 'high' });
    assert.equal(
      await f.hooks.get('before_prompt_build')!(
        {},
        {
          agentId: 'a',
          sessionKey: 'agent:a:reports',
          sessionId: 'incarnation',
          runId: randomUUID(),
        },
      ),
      undefined,
    );
    assert.equal(
      await f.hooks.get('before_tool_call')!(
        {},
        {
          agentId: 'a',
          sessionKey: 'agent:a:other',
          sessionId: 'incarnation',
          runId: input.executionId,
        },
      ),
      undefined,
    );
    assert.ok(!f.calls.includes('chat.inject'));
  });
  it('should retain pending admission without calling it delivery or replaying submission', async () => {
    const f = fixture({ pending: true });
    assert.equal((await f.deliver()).status, 'pending');
    assert.equal((await f.recover()).status, 'pending');
    assert.equal(f.messages.length, 1);
    assert.equal((await f.store.read(input.executionId))?.input.outcome, 'error');
  });
  it('should preserve uncertain sends and reconcile the same durable identity after restart', async () => {
    const f = fixture({ lostAck: true });
    assert.equal((await f.deliver()).status, 'uncertain');
    assert.equal((await f.recover()).status, 'uncertain');
    assert.equal(f.messages.length, 1);
    const reopened = new AutomationReportStore(f.store.root);
    assert.equal((await reopened.read(input.executionId))?.state, 'uncertain');
  });
  it('should recover a final reply after a malformed acknowledgment without a second send', async () => {
    const f = fixture({ malformed: true });
    assert.equal((await f.deliver()).status, 'uncertain');
    assert.equal((await f.recover()).status, 'delivered');
    assert.equal(f.messages.length, 1);
  });
  it('should preserve a concurrent terminal receipt after losing the send acknowledgment', async () => {
    const f = fixture({ settledBeforeAck: true });
    assert.equal((await f.deliver()).status, 'delivered');
    assert.equal((await f.recover()).status, 'delivered');
    assert.equal(f.messages.length, 1);
    assert.equal((await f.store.read(input.executionId))?.code, undefined);
  });
  it('should reject contradictory final cards even when the model run finished', async () => {
    const f = fixture({ badCard: true });
    assert.equal((await f.deliver()).status, 'failed');
    assert.equal((await f.store.read(input.executionId))?.code, 'automation-report-card-invalid');
  });
  it('should retain sanitized captured results without sending to unavailable or drifted targets', async () => {
    for (const options of [
      { archived: true },
      { otherWorkspace: true },
      { revoked: true },
      { stale: true },
      { drift: true },
      { hookDenied: true },
    ]) {
      const f = fixture(options);
      const id = randomUUID();
      assert.equal((await f.deliver(id)).status, 'pending');
      assert.equal(f.messages.length, 0);
      assert.equal((await f.store.read(id))?.input.reason, 'Exit 17');
    }
  });
  it('should distinguish a definite native rejection from an ambiguous send', async () => {
    const f = fixture({ denied: true });
    assert.equal((await f.deliver()).status, 'pending');
    const record = await f.store.read(input.executionId);
    assert.equal(record?.code, 'automation-report-rejected');
    assert.ok(!JSON.stringify(record).includes('private diagnostic'));
  });
  it('should claim concurrent recovery once without discarding the committed source', async () => {
    const f = fixture({ pending: true });
    await Promise.all([f.deliver(), f.deliver()]);
    assert.equal(f.messages.length, 1);
    const original = await f.store.read(input.executionId);
    await assert.rejects(
      f.store.update(input.executionId, (record) => {
        record.input.stdout.body = 'x'.repeat(300_000);
      }),
    );
    assert.deepEqual(await f.store.read(input.executionId), original);
  });
});
