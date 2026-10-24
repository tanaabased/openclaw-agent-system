import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from '@openclaw/gateway-client';

/** admit this fixture, then advance retained work in the existing native coordinator. */
export default async function refreshNotifications(input: {
  request(timeoutMs: number): unknown | Promise<unknown>;
  ready(timeoutMs: number): boolean | Promise<boolean>;
  dispatch(timeoutMs: number): Promise<{ runId?: unknown }>;
  report(receipt: unknown): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  timeoutMs: number;
}): Promise<string> {
  const deadline = input.now() + input.timeoutMs;
  const remaining = () => {
    const milliseconds = Math.floor(deadline - input.now());
    if (milliseconds <= 0)
      throw new Error('notification refresh timed out waiting for fixture admission');
    return milliseconds;
  };
  while (input.now() < deadline) {
    const receipt = await input.request(remaining());
    input.report(receipt);
    assert.ok(receipt && typeof receipt === 'object', 'invalid notification refresh receipt');
    assert.equal(
      (receipt as Record<string, unknown>).status,
      'completed',
      'selected intake failed',
    );
    if (await input.ready(remaining())) {
      const run = await input.dispatch(remaining());
      input.report(run);
      assert.ok(
        typeof run.runId === 'string' && run.runId.trim(),
        'native dispatch requires a run id',
      );
      return run.runId;
    }
    await input.sleep(Math.min(2000, Math.max(0, deadline - input.now())));
  }
  throw new Error('notification refresh timed out waiting for fixture admission');
}

/** reserve process startup and cleanup beyond the explicitly selected native operation allowance. */
export function notificationCli(
  args: string[],
  timeoutMs: number,
  warnings = false,
  run = spawnSync,
) {
  const result = run('openclaw', args, { encoding: 'utf8', timeout: timeoutMs + 30_000 });
  assert.ok(
    result.status === 0 || (warnings && result.status === 1),
    result.error?.message ?? String(result.stdout) + String(result.stderr),
  );
  return JSON.parse(String(result.stdout));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions only.');
  const { values } = parseArgs({
    options: {
      repository: { type: 'string' },
      kind: { type: 'string' },
      number: { type: 'string' },
    },
  });
  assert.ok(
    values.repository && values.kind === 'issue' && values.number,
    'a fixture repository, issue kind and number are required',
  );
  const selector = [
    '--repository',
    values.repository,
    '--kind',
    values.kind,
    '--number',
    values.number,
  ];
  const { callGatewayFromCli } = await import('openclaw/plugin-sdk/gateway-runtime');
  const runId = await refreshNotifications({
    request: (timeout) =>
      notificationCli(
        [
          'agent-system',
          'notifications',
          'refresh',
          ...selector,
          '--timeout',
          String(Math.max(1, Math.floor(timeout / 1000))),
          '--json',
        ],
        timeout,
      ),
    ready(timeout) {
      const status = notificationCli(
        ['agent-system', 'notifications', 'status', ...selector, '--json'],
        timeout,
        true,
      );
      assert.equal(status.diagnosticCode, undefined, 'fixture intake must be healthy');
      return status.items.length === 1;
    },
    async dispatch(timeoutMs) {
      const deadline = performance.now() + timeoutMs;
      const remaining = () => {
        const milliseconds = Math.floor(deadline - performance.now());
        assert.ok(
          milliseconds > 0,
          'native coordinator dispatch observation deadline exhausted; do not replay an uncertain send',
        );
        return milliseconds;
      };
      const installed = notificationCli(
        ['agent-system', 'automations', 'list', '--json'],
        remaining(),
      );
      assert.equal(installed.status, 'aligned');
      const jobs = installed.jobs.filter(
        (job: { id: string }) => job.id === 'github-issue-assignment',
      );
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].nativeEnabled, true);
      const read = {
        scopes: ['operator.read' as const],
        progress: false,
        sharedStateMode: 'read-only' as const,
      };
      const job = await callGatewayFromCli(
        'cron.get',
        { json: true, timeout: String(Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remaining())) },
        { id: jobs[0].nativeId },
        read,
      );
      assert.ok(
        typeof job.sessionTarget === 'string' && job.sessionTarget.startsWith('session:'),
        'installed coordinator required',
      );
      const sessionKey = job.sessionTarget.slice('session:'.length);
      const history = await callGatewayFromCli(
        'chat.history',
        { json: true, timeout: String(Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remaining())) },
        { sessionKey, limit: 1 },
        read,
      );
      const sessionInfo = history.sessionInfo as {
        activeLeafEntryId?: string;
        hasActiveRun: boolean;
      };
      assert.equal(sessionInfo.hasActiveRun, false, 'wait for the preceding coordinator run');
      return callGatewayFromCli(
        'chat.send',
        { json: true, timeout: String(Math.min(DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, remaining())) },
        {
          sessionKey,
          agentId: job.agentId,
          sessionId: history.sessionId,
          message:
            'Advance previously admitted issue or feedback work. Use agent_system_dispatch action next and follow its routing, preparation, assessment or reconciliation result. Do not scan intake.',
          expectedLeafEntryId: sessionInfo.activeLeafEntryId ?? null,
          queueMode: 'followup',
          deliver: false,
          idempotencyKey: randomUUID(),
        },
        { scopes: ['operator.admin'], progress: false, sharedStateMode: 'read-only' },
      );
    },
    report: (receipt) => process.stderr.write(JSON.stringify(receipt) + '\n'),
    sleep: setTimeout,
    now: () => performance.now(),
    timeoutMs: 180000,
  });
  process.stdout.write(runId + '\n');
}
