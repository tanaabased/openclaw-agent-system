import assert from 'node:assert/strict';
import { GatewayClientRequestError } from '@openclaw/gateway-client';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';

import deliverAutomationReport, {
  reconcileAutomationReport,
} from '../agent/automations/automation-report-delivery.ts';
import AutomationReportStore from '../agent/automations/automation-report-store.ts';
import {
  prepareLegacyAutomationReport,
  type AutomationReportInput,
} from '../agent/automations/automation-report.ts';
import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import { sessionDispatchRequest } from '../credentials/session-dispatch-client.ts';
import registerAutomationReportHooks from '../core/automation-report-hook.ts';
import { AutomationError } from '../agent/automations/automation-gateway.ts';

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
      unguarded?: boolean;
      settledBeforeAck?: boolean;
      requestGuard?: boolean;
      selectionError?: string;
      effectiveMismatch?: boolean;
      effectiveEffort?: string;
      historyFailure?: boolean;
      stdout?: string;
      alteredPreferred?: boolean;
      correction?: 'valid' | 'duplicate' | 'multipart';
      legacy?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
    const messages: string[] = [];
    const replies: unknown[] = [];
    const stages: { first: string; instruction: string; corrected: string; saved: string[] }[] = [];
    let selections = 0;
    let selected = false;
    const store = new AutomationReportStore(`${workspaceDir}/reports`, () =>
      Date.parse(input.startedAt),
    );
    type HookResult =
      | {
          toolsAllow?: string[];
          appendSystemContext?: string;
          block?: boolean;
          retry?: { maxAttempts?: number; instruction?: string; idempotencyKey?: string };
        }
      | undefined;
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
        const request = async (method: string, params: Record<string, unknown>) => {
          calls.push(method);
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
                  model: options.drift && !selected ? 'test/other' : target.model,
                  thinkingLevel: target.effort,
                },
              ],
            };
          if (method === 'chat.history') {
            if (options.historyFailure) throw new Error('history transport unavailable');
            return { sessionId: 'incarnation', messages: replies };
          }
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
          if (!options.unguarded) {
            const guard = await hooks.get('before_prompt_build')!({}, context);
            assert.equal(guard?.toolsAllow, undefined);
            assert.ok(guard?.appendSystemContext);
          }
          assert.equal(
            (await hooks.get('before_tool_call')!({ toolName: 'exec' }, context))?.block,
            true,
          );
          await hooks.get('llm_output')!(
            {
              runId: params.idempotencyKey,
              provider: 'test',
              model: options.effectiveMismatch ? 'other' : 'formatter',
              ...(options.effectiveEffort ? { reasoningEffort: options.effectiveEffort } : {}),
            },
            context,
          );
          const record = await store.read(String(params.idempotencyKey));
          const presentation = record!.input.presentation;
          let body =
            presentation && presentation.kind !== 'fallback'
              ? (options.alteredPreferred ? 'Changed report\n' : '') + presentation.body
              : presentation?.kind === 'fallback'
                ? `> ## ${options.badCard ? '✅' : '❌'} Backup failed\n>\n> The command exited unsuccessfully.\n\n${presentation.footer}`
                : `> ## ❌ Backup failed\n>\n> ${record!.input.runLine}\n>\n> The command exited unsuccessfully.`;
          if (options.correction) {
            const escaped = body.replaceAll('&', '&amp;').replaceAll('>', '&gt;');
            body = body.replaceAll('\n\n', '\n>\n') + '\n\n' + JSON.stringify(escaped);
          }
          const validation = await hooks.get('before_agent_finalize')!(
            { lastAssistantMessage: body },
            context,
          );
          if (options.badCard || options.alteredPreferred || options.correction)
            assert.equal(validation?.retry?.maxAttempts, 1);
          else assert.equal(validation, undefined);
          let saved = [body];
          if (options.correction) {
            const instruction = validation?.retry?.instruction;
            assert.ok(instruction);
            assert.equal(
              validation?.retry?.idempotencyKey,
              `automation-report:${params.idempotencyKey}`,
            );
            const marker = '\n<response_body>\n';
            const start = instruction.indexOf(marker) + marker.length;
            const corrected = instruction.slice(
              start,
              instruction.indexOf('\n</response_body>', start),
            );
            assert.ok(instruction.includes('Replace the rejected response in full'));
            saved =
              options.correction === 'multipart'
                ? [corrected, JSON.stringify(corrected)]
                : [corrected + (options.correction === 'duplicate' ? '\n\n' + corrected : '')];
            stages.push({ first: body, instruction, corrected, saved });
            const finalValidation = await hooks.get('before_agent_finalize')!(
              { lastAssistantMessage: saved.join('\n') },
              context,
            );
            assert.equal(Boolean(finalValidation), options.correction !== 'valid');
          }
          if (!options.pending)
            replies.push({
              role: 'assistant',
              stopReason: 'stop',
              content: saved.map((text) => ({ type: 'text', text })),
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
        };
        return operation(
          options.requestGuard ? sessionDispatchRequest(request, authority) : request,
        );
      },
    };
    async function selectSettings() {
      selections++;
      if (options.selectionError) throw new AutomationError(options.selectionError);
      selected = true;
    }
    const deliver = async (executionId = input.executionId) => {
      const runInput = {
        ...input,
        executionId,
        ...(options.stdout === undefined
          ? {}
          : { result: { ...input.result, output: { stdout: options.stdout, stderr: '' } } }),
      };
      if (options.legacy && !(await store.read(executionId)))
        await store.write({
          version: 1,
          executionId,
          hash: 'hash',
          manifestDigest: 'manifest',
          target,
          input: prepareLegacyAutomationReport(runInput),
          state: 'pending',
        });
      return deliverAutomationReport({
        target,
        input: runInput,
        store,
        hash: 'hash',
        manifestDigest: 'manifest',
        credential,
        assertCurrent,
        selectSettings,
      });
    };
    const recover = (executionId = input.executionId) =>
      reconcileAutomationReport({ store, executionId, credential, assertCurrent, selectSettings });
    return {
      deliver,
      recover,
      calls,
      messages,
      store,
      hooks,
      stages,
      replies,
      selections: () => selections,
    };
  }
  it('should validate the corrected saved four-card reply rather than the first candidate', async () => {
    const stdout = JSON.stringify({
      schema: 'agent-system.report',
      version: 1,
      cards: ['canon', 'emori', 'smutlord', 'openclaw-agent-system'].map((id) => ({
        id,
        format: 'structured',
        title: id,
        status: 'success',
        summary: 'Source saved.',
      })),
    });
    for (const correction of ['valid', 'duplicate', 'multipart'] as const) {
      const executionId = randomUUID();
      const f = fixture({ stdout, correction });
      const result = await f.deliver(executionId);
      const record = await f.store.read(executionId);
      assert.ok(record?.input.presentation && record.input.presentation.kind !== 'fallback');
      const expected = record.input.presentation.body;
      const stage = f.stages[0]!;
      assert.notEqual(stage.first, expected);
      assert.equal(stage.corrected, expected);
      assert.equal(stage.corrected.split('\n\n> ##').length, 4);
      assert.ok(stage.corrected.includes('\n\n**Runner result:**'));
      assert.equal(f.replies.length, 1);
      assert.equal(result.status, correction === 'valid' ? 'delivered' : 'failed');
      if (correction === 'valid') {
        assert.deepEqual(stage.saved, [expected]);
        assert.equal(result.messageId, `reply-${executionId}`);
      } else assert.equal(result.code, 'automation-report-card-invalid');
      assert.equal((await f.recover(executionId)).status, result.status);
      assert.equal(f.messages.length, 1);
    }
  });
  it('should deliver one retained mixed response and reconcile its original receipt without replay', async () => {
    const stdout = JSON.stringify({
      schema: 'agent-system.report',
      version: 1,
      cards: [
        {
          id: 'a',
          format: 'structured',
          title: 'Saved',
          status: 'success',
          summary: 'Archive saved.',
        },
        { id: 'b', format: 'markdown', body: '## Warning\n\nActivation unverified.' },
      ],
    });
    const f = fixture({ stdout, malformed: true });
    assert.equal((await f.deliver()).status, 'uncertain');
    const retained = await f.store.read(input.executionId);
    assert.equal(retained?.input.presentation?.kind, 'preferred');
    assert.equal((await f.recover()).status, 'delivered');
    assert.equal(f.messages.length, 1);
    assert.equal(f.selections(), 1);
    assert.equal(f.calls.includes('chat.inject'), false);
    const bad = fixture({ stdout, alteredPreferred: true });
    const badId = randomUUID();
    assert.equal((await bad.deliver(badId)).status, 'failed');
    assert.equal((await bad.store.read(badId))?.code, 'automation-report-card-invalid');
  });
  it('should preserve admitted legacy formatting and native identity', async () => {
    const f = fixture({ legacy: true });
    assert.equal((await f.deliver()).status, 'delivered');
    assert.equal((await f.store.read(input.executionId))?.input.presentation, undefined);
    assert.equal(f.messages.length, 1);
  });
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
    assert.deepEqual(saved?.effective, { model: 'test/formatter' });
    assert.equal(saved?.target.effort, 'high');
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
  it('should block formatter tool attempts without replacing the automation report', async () => {
    const f = fixture({ pending: true });
    await f.deliver();
    const before = await f.store.read(input.executionId);
    const context = {
      agentId: 'a',
      sessionKey: 'agent:a:reports',
      sessionId: 'incarnation',
    };
    for (const toolName of [
      'exec_command',
      'apply_patch',
      'message',
      'web_search',
      'mcp__fixture__write',
      'spawn_agent',
    ]) {
      const result = await f.hooks.get('before_tool_call')!(
        { toolName, runId: input.executionId },
        context,
      );
      assert.equal(result?.block, true, toolName);
    }
    assert.deepEqual(await f.store.read(input.executionId), before);
    assert.equal(f.messages.length, 1);
    assert.equal(
      await f.hooks.get('before_tool_call')!(
        { toolName: 'exec_command', runId: randomUUID() },
        context,
      ),
      undefined,
    );
  });
  it('should block tool execution when formatter custody cannot be read', async () => {
    const f = fixture();
    f.store.read = async () => {
      throw new Error('fixture storage failure');
    };
    assert.equal(
      (
        await f.hooks.get('before_tool_call')!(
          { toolName: 'exec_command', runId: input.executionId },
          { agentId: 'a', sessionKey: 'agent:a:reports', sessionId: 'incarnation' },
        )
      )?.block,
      true,
    );
  });
  it('should deliver through the enrolled request guard without a plugin inspection', async () => {
    const f = fixture({ requestGuard: true });
    assert.equal((await f.deliver()).status, 'delivered');
    assert.ok(!f.calls.includes('plugins.inspect'));
    assert.equal(f.messages.length, 1);
  });
  it('should diagnose unobserved formatter hooks without claiming delivery or replaying', async () => {
    const f = fixture({ unguarded: true });
    const result = await f.deliver();
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'automation-report-hooks-not-observed');
    assert.equal((await f.recover()).status, 'failed');
    assert.equal(f.messages.length, 1);
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
  it('should retain sanitized captured results without sending to unavailable targets', async () => {
    for (const options of [
      { archived: true },
      { otherWorkspace: true },
      { revoked: true },
      { stale: true },
    ]) {
      const f = fixture(options);
      const id = randomUUID();
      assert.equal((await f.deliver(id)).status, 'pending');
      assert.equal(f.messages.length, 0);
      assert.equal((await f.store.read(id))?.input.reason, 'Exit 17');
    }
  });
  it('should select settings once before sending and never select again for a submitted run', async () => {
    const f = fixture({ drift: true, pending: true });
    await Promise.all([f.deliver(), f.deliver()]);
    assert.equal(f.messages.length, 1);
    assert.equal(f.selections(), 1);
    await f.recover();
    assert.equal(f.selections(), 1);
    assert.equal(f.messages.length, 1);
  });
  it('should fail unavailable selection without sending or losing the captured command outcome', async () => {
    const f = fixture({ selectionError: 'automation-model-unavailable' });
    const result = await f.deliver();
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'automation-report-model-unavailable');
    assert.equal(f.messages.length, 0);
    await f.recover();
    assert.equal(f.selections(), 1);
    assert.equal((await f.store.read(input.executionId))?.input.reason, 'Exit 17');
  });
  for (const phase of ['denied', 'uncertain'])
    it(`should fail a ${phase} selection without replaying it on report recovery`, async () => {
      const f = fixture({ selectionError: `automation-thread-settings-${phase}` });
      assert.equal((await f.deliver()).status, 'failed');
      assert.equal((await f.recover()).code, `automation-report-settings-${phase}`);
      assert.equal(f.selections(), 1);
      assert.equal(f.messages.length, 0);
    });
  it('should reject effective settings mismatch without reporting successful delivery', async () => {
    const f = fixture({ effectiveMismatch: true });
    assert.equal((await f.deliver()).status, 'failed');
    assert.equal(
      (await f.store.read(input.executionId))?.code,
      'automation-report-settings-mismatch',
    );
  });
  it('should verify reported execution effort without inventing absent telemetry', async () => {
    for (const effectiveEffort of [undefined, 'high', 'low']) {
      const f = fixture({ effectiveEffort });
      const result = await f.deliver(randomUUID());
      assert.equal(result.status, effectiveEffort === 'low' ? 'failed' : 'delivered');
      const saved = await f.store.read(result.executionId);
      assert.equal(saved?.effective?.effort, effectiveEffort);
      assert.equal(saved?.target.effort, 'high');
      if (effectiveEffort === 'low')
        assert.equal(result.code, 'automation-report-settings-mismatch');
    }
  });
  it('should preserve an acknowledged send when later history inspection fails', async () => {
    const options = { historyFailure: true, pending: true };
    const f = fixture(options);
    await f.deliver();
    assert.equal((await f.store.read(input.executionId))?.state, 'submitted');
    options.historyFailure = false;
    await f.recover();
    assert.equal(f.messages.length, 1);
    assert.equal(f.selections(), 1);
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
