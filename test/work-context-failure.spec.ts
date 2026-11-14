import assert from 'node:assert/strict';
import openClawWorkAction, {
  verifyOpenClawWork,
} from '../agent/tasks/implementation/openclaw-work.ts';
import codexWorkContext from '../agent/tasks/implementation/codex-work-context.ts';
import type { OpenClawDispatchRecord } from '../agent/tasks/dispatch/openclaw-dispatch-state.ts';
import type { DispatchRecord } from '../agent/tasks/dispatch/codex-dispatch-state.ts';
import workflowFailure from '../agent/tasks/workflow-failure.ts';

const caller = { sessionKey: 'chat', sessionId: 'session', runId: 'run', toolCallId: 'call' };
const source = { runId: 'run', inputEventId: 'input' };
const progression = { stage: 'implementation', via: 'work' } as const;
function record() {
  return {
    id: 'task',
    threadId: 'chat',
    sessionCreation: { sessionId: 'session' },
    request: { key: 'chat', agentId: 'agent', cwd: process.cwd() },
    worktree: '/SECRET/checkout',
    work: {},
    nativeWork: {},
  } as unknown as OpenClawDispatchRecord;
}

describe('implementation failure diagnostics', () => {
  it('should distinguish session validation from decision persistence without replacing errors', async () => {
    for (const step of ['session-validation', 'decision-persistence'] as const) {
      const error = Object.assign(new Error('SECRET token /private/path'), { code: 'ENOSPC' });
      const task = record();
      const reasons = ['bounded task'];
      Object.freeze(reasons);
      const decision = Object.freeze({ mode: 'work' as const, reasons });
      await assert.rejects(
        verifyOpenClawWork({
          record: task,
          caller,
          operator: false,
          feedback: { inputId: 'input', message: 'SECRET prompt' },
          mode: 'auto',
          decision,
          now: 1,
          config: {},
          request: async () => {
            if (step === 'session-validation') throw error;
            return {
              session: {
                key: 'chat',
                sessionId: 'session',
                agentId: 'agent',
                workspaceDir: process.cwd(),
              },
            };
          },
          save: async () => {
            assert.deepEqual(task.implementationDecision, decision);
            assert.notEqual(task.implementationDecision, decision);
            assert.notEqual(task.implementationDecision?.reasons, decision.reasons);
            assert.equal(Object.isFrozen(task.implementationDecision), false);
            assert.equal(Object.isFrozen(task.implementationDecision?.reasons), false);
            throw error;
          },
        }),
        (caught) => {
          assert.equal(caught, error);
          assert.deepEqual(workflowFailure(caught, 'dispatch-operation-failed'), {
            code: 'dispatch-operation-failed',
            failureDiagnostic: { step, category: 'error', code: 'ENOSPC' },
          });
          return true;
        },
      );
    }
  });

  it('should identify implementation save failures and leave successful context free of diagnostics', async () => {
    const input = {
      record: record(),
      caller,
      source,
      progression,
      action: { action: 'implementation-context', id: 'task' } as const,
      now: 1,
      assertCurrent: async () => {},
      save: async () => {},
    };
    const error = new TypeError('SECRET state');
    await assert.rejects(
      openClawWorkAction({
        ...input,
        save: async () => {
          throw error;
        },
      }),
      (caught) => {
        assert.equal(caught, error);
        assert.equal(
          workflowFailure(caught, 'fallback').failureDiagnostic?.step,
          'implementation-persistence',
        );
        return true;
      },
    );
    const output = await openClawWorkAction(input);
    assert.equal(output.status, 'verified');
    assert.equal('failureDiagnostic' in output, false);
    assert.equal('notice' in output, false);
  });

  for (const runtime of ['codex', 'openclaw'] as const) {
    it(`should locate malformed implementation material without exposing it in ${runtime}`, async () => {
      const task = {
        ...record(),
        context: '{"source":"https://github.com/owner/repo/issues/1"}',
        routing: 'SECRET malformed routing',
      };
      const operation =
        runtime === 'openclaw'
          ? openClawWorkAction({
              record: task,
              caller,
              source,
              progression,
              action: { action: 'implementation-context', id: 'task' },
              now: 1,
              assertCurrent: async () => {},
              save: async () => {},
            })
          : codexWorkContext(
              task as unknown as DispatchRecord,
              {
                current: { workspace: '/workspace', manifest: { debug: false } },
                deps: {},
              } as never,
              { selection: undefined } as never,
              true,
            );
      await assert.rejects(operation, (error) => {
        assert.ok(error instanceof SyntaxError);
        assert.deepEqual(workflowFailure(error, 'dispatch-operation-failed'), {
          code: 'dispatch-operation-failed',
          failureDiagnostic: { step: 'implementation-material', category: 'syntax-error' },
        });
        return true;
      });
    });
  }
});
