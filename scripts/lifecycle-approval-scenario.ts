import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { getRuntimeConfig } from 'openclaw/plugin-sdk/runtime-config-snapshot';
import { GatewayClient } from 'openclaw/plugin-sdk/gateway-runtime';
import type { PluginApprovalRequest } from 'openclaw/plugin-sdk/approval-runtime';

// This exercises an installed Gateway and must never run against a developer profile.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions-only acceptance scenario');
const agentId = process.argv[2];
assert.ok(agentId === 'tanaabot' || agentId === 'emori');
const temporaryDirectory = process.env.TMPDIR;
assert.ok(temporaryDirectory);
const checkFile = join(temporaryDirectory, 'agent-system-doctor-check');
const applyFile = join(temporaryDirectory, 'agent-system-forbidden-setup');
const exec = promisify(execFile);
const config = getRuntimeConfig({ pin: false });
assert.equal(typeof config.gateway?.auth?.token, 'string', 'fixture must use token auth');
const token = config.gateway!.auth!.token as string;
const port = config.gateway?.port ?? 18789;
type Event = { event: string; payload?: unknown };
const events: Event[] = [];
let client: GatewayClient;
const connected = new Promise<void>((resolve, reject) => {
  client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    token,
    clientName: 'openclaw-control-ui',
    mode: 'webchat',
    clientDisplayName: 'Agent System Leia approval fixture',
    scopes: ['operator.admin', 'operator.approvals', 'operator.read', 'operator.write'],
    caps: ['tool-events'],
    onHelloOk: () => resolve(),
    onConnectError: reject,
    onEvent: (event) => events.push(event),
  });
  client.start();
});

async function waitFor<T>(
  read: () => T | undefined,
  label: string,
  timeoutMs = 180_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function contents(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function approvalFor(sessionKey: string) {
  return events
    .filter(({ event }) => event === 'plugin.approval.requested')
    .map(({ payload }) => payload as PluginApprovalRequest)
    .filter(
      ({ request }) => request?.sessionKey === sessionKey && request.pluginId === 'agent-system',
    );
}

async function assertUntouched() {
  assert.equal(await contents(checkFile), '', 'Doctor checks ran without approval');
  assert.equal(await contents(applyFile), '', 'install ran without approval');
  // The apply marker is an empty file, so inspect existence separately.
  await assert.rejects(readFile(applyFile), { code: 'ENOENT' });
}

try {
  await Promise.race([
    connected,
    delay(30_000).then(() => {
      throw new Error('Control UI connection timed out');
    }),
  ]);
  for (const toolName of ['agent_system_install', 'agent_system_doctor']) {
    for (const decision of ['deny', 'cancel', 'unavailable', 'allow-once'] as const) {
      await Promise.all([rm(checkFile, { force: true }), rm(applyFile, { force: true })]);
      events.length = 0;
      const sessionKey: string = `agent:${agentId}:lifecycle-${randomUUID()}`;
      const message = `Call ${toolName} exactly once with {} for this active agent. Discover the native OpenClaw tool if necessary. Do not invoke shell commands, another agent, or any other lifecycle tool. Let OpenClaw present its approval; after the tool finishes or is blocked, stop without retrying. This is an approval-boundary acceptance test.`;
      if (decision === 'unavailable') {
        // CLI turns have no originating chat approval surface, even with an operator client connected.
        await exec(
          'openclaw',
          [
            'agent',
            '--agent',
            agentId,
            '--session-key',
            sessionKey,
            '--message',
            message,
            '--timeout',
            '180',
            '--json',
          ],
          { timeout: 210_000, maxBuffer: 2_000_000 },
        );
        const history = await client!.request<{ messages: unknown[] }>('chat.history', {
          sessionKey,
          limit: 50,
        });
        const toolResults = history.messages.filter((entry) => {
          const row = entry as { role?: string; toolName?: string };
          return row.role === 'toolResult' && row.toolName === toolName;
        });
        assert.ok(
          toolResults.length > 0,
          'unavailable case must exercise the actual lifecycle tool',
        );
        assert.match(JSON.stringify(toolResults), /approval/i);
        assert.equal(approvalFor(sessionKey).length, 0);
        await assertUntouched();
      } else {
        const accepted = await client!.request<{ runId: string }>('chat.send', {
          sessionKey,
          message,
          idempotencyKey: randomUUID(),
        });
        const approval = await waitFor(
          () => approvalFor(sessionKey)[0],
          'originating chat approval',
        );
        assert.equal(approval.request.toolName, toolName);
        assert.equal(approval.request.agentId, agentId);
        assert.deepEqual(approval.request.allowedDecisions, ['allow-once', 'deny']);
        assert.ok(approval.request.description.includes(agentId));
        assert.match(approval.request.description, /Manifest [a-f0-9]{12}/);
        await assertUntouched();
        if (decision === 'cancel') {
          await client!.request('chat.abort', { sessionKey, runId: accepted.runId });
        } else {
          await client!.request('plugin.approval.resolve', { id: approval.id, decision });
        }
        await waitFor(
          () =>
            events.find(({ event, payload }) => {
              const row = payload as { runId?: string; state?: string } | undefined;
              return (
                event === 'chat' &&
                row?.runId === accepted.runId &&
                ['final', 'aborted', 'error'].includes(row.state ?? '')
              );
            }),
          'chat completion',
        );
        assert.equal(approvalFor(sessionKey).length, 1, 'unexpected lifecycle retry');
        if (decision === 'allow-once') {
          assert.ok((await contents(checkFile)).includes('checked'), 'approved checks did not run');
          if (toolName === 'agent_system_install') await readFile(applyFile);
          else await assert.rejects(readFile(applyFile), { code: 'ENOENT' });
        } else await assertUntouched();
      }
      process.stdout.write(`${agentId} ${toolName} ${decision}: verified\n`);
    }
  }
} finally {
  await client!.stopAndWait();
  await Promise.all([rm(checkFile, { force: true }), rm(applyFile, { force: true })]);
}
