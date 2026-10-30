import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';

import deliverAutomationReport from '../agent/automation-report-delivery.ts';
import type { AutomationReportInput } from '../agent/automation-report.ts';

const input: AutomationReportInput = {
  id: 'backup',
  executionId: 'execution-1',
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
    } = {},
  ) {
    const calls: string[] = [];
    const messages: string[] = [];
    const target = { sessionKey: 'agent:a:reports', agentId: 'a', workspaceDir, scope: 'fixture' };
    const deliver = (executionId = input.executionId) =>
      deliverAutomationReport({
        target,
        input: { ...input, executionId },
        async assertCurrent() {
          if (options.stale) throw Error('stale');
        },
        credential: {
          async use(authority, operation) {
            assert.equal(authority.signal?.aborted, false);
            await authority.assertCurrent?.();
            if (options.revoked) throw Error('revoked');
            return operation(async (method, params) => {
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
                    },
                  ],
                };
              assert.equal(method, 'chat.inject');
              assert.equal(params.sessionKey, target.sessionKey);
              messages.push(String(params.message));
              if (options.lostAck) throw Error('lost acknowledgment');
              return options.malformed ? {} : { ok: true, messageId: `message-${messages.length}` };
            });
          },
        },
      });
    return { deliver, calls, messages };
  }
  it('should append captured failure to the same chat without starting an agent turn', async () => {
    const f = fixture();
    const results = await Promise.all([f.deliver(), f.deliver('execution-2')]);
    assert.deepEqual(
      results.map(({ status }) => status),
      ['delivered', 'delivered'],
    );
    assert.equal(f.messages.length, 2);
    assert.ok(f.messages[0]!.includes('exit code 17'));
    assert.ok(f.messages[0]!.includes('# Saved'));
    assert.ok(f.messages.some((message) => message.includes('execution-2')));
    assert.ok(
      f.calls.every((method) =>
        ['sessions.resolve', 'sessions.list', 'chat.inject'].includes(method),
      ),
    );
  });
  it('should preserve uncertain append results without retrying', async () => {
    for (const options of [{ lostAck: true }, { malformed: true }]) {
      const f = fixture(options);
      assert.equal((await f.deliver()).status, 'uncertain');
      assert.equal(f.messages.length, 1);
      assert.equal(f.calls.filter((method) => method === 'chat.inject').length, 1);
    }
  });
  it('should refuse unavailable destinations and credentials before append', async () => {
    for (const options of [
      { archived: true },
      { otherWorkspace: true },
      { revoked: true },
      { stale: true },
    ]) {
      const f = fixture(options);
      assert.equal((await f.deliver()).status, 'not-delivered');
      assert.equal(f.messages.length, 0);
    }
  });
});
