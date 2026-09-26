import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { getRuntimeConfig } from 'openclaw/plugin-sdk/runtime-config-snapshot';
import { GatewayClient } from 'openclaw/plugin-sdk/gateway-runtime';
import type { PluginApprovalRequest } from 'openclaw/plugin-sdk/approval-runtime';

// This exercises an installed Gateway and must never run against a developer profile.
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'GitHub Actions-only acceptance scenario');
const agentId = process.argv[2];
assert.ok(agentId === 'approval-codex' || agentId === 'approval-openclaw');
const operation = process.argv[3] ?? 'install';
assert.ok(operation === 'doctor' || operation === 'install');
const temporaryDirectory = process.env.TMPDIR;
assert.ok(temporaryDirectory);
const checkFile = join(temporaryDirectory, 'agent-system-approval-check');
const applyFile = join(temporaryDirectory, 'agent-system-approval-apply');
const testCase =
  operation === 'doctor'
    ? { decision: 'allow-once' as const, toolName: 'agent_system_doctor' as const }
    : {
        decision: agentId === 'approval-codex' ? ('allow-once' as const) : ('deny' as const),
        toolName: 'agent_system_install' as const,
      };
const config = getRuntimeConfig({ pin: false });
assert.equal(typeof config.gateway?.auth?.token, 'string', 'fixture must use token auth');
const token = config.gateway!.auth!.token as string;
const port = config.gateway?.port ?? 18789;
const origin = `http://127.0.0.1:${port}`;
const controlUi = await fetch(`${origin}/__openclaw__/`, {
  signal: AbortSignal.timeout(30_000),
});
assert.ok(controlUi.ok, `Control UI document request failed: ${controlUi.status}`);
// The document identity appends an asset hash to the Gateway build ID.
const clientBuildId = (await controlUi.text()).match(
  /<html\b[^>]*\sdata-openclaw-control-ui-build-id="([a-zA-Z0-9._-]{1,96})-[a-f0-9]{64}"/i,
)?.[1];
assert.ok(clientBuildId, 'Control UI document must identify its Gateway build');
type Event = { event: string; payload?: unknown };
const events: Event[] = [];
let activeSessionKey: string | undefined;
let activeRunId: string | undefined;
const approvalIds = new Set<string>();

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function traceEvent({ event, payload }: Event) {
  if (!activeSessionKey) return;
  const row = record(payload);
  const request = record(row.request);
  if (event.startsWith('plugin.approval.')) {
    if (request.sessionKey === activeSessionKey && typeof row.id === 'string')
      approvalIds.add(row.id);
    if (typeof row.id !== 'string' || !approvalIds.has(row.id)) return;
    process.stdout.write(
      `${JSON.stringify({ event, id: row.id, toolCallId: request.toolCallId, tool: request.toolName, runId: request.runId, decision: row.decision, reason: row.reason, createdAtMs: row.createdAtMs, expiresAtMs: row.expiresAtMs })}\n`,
    );
  } else if (
    (row.sessionKey === activeSessionKey || (activeRunId && row.runId === activeRunId)) &&
    (event === 'agent' || event === 'chat')
  ) {
    const data = record(row.data);
    if (event === 'agent' && row.stream !== 'tool') return;
    if (event === 'chat' && !['final', 'aborted', 'error'].includes(String(row.state))) return;
    const result = JSON.stringify(data.result ?? data.error ?? row.errorMessage ?? '');
    process.stdout.write(
      `${JSON.stringify({ event, runId: row.runId, state: row.state, phase: data.phase, tool: data.name, toolCallId: data.toolCallId, isError: data.isError, lifecycleApprovalDenied: result.includes('Lifecycle approval is missing'), approvalUnavailable: result.includes('Plugin approval unavailable') })}\n`,
    );
  }
}

let client: GatewayClient;
const connected = new Promise<void>((resolve, reject) => {
  client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    origin,
    token,
    clientName: 'openclaw-control-ui',
    clientBuildId,
    mode: 'webchat',
    clientDisplayName: 'Agent System Leia approval fixture',
    scopes: ['operator.admin', 'operator.approvals', 'operator.read', 'operator.write'],
    caps: ['tool-events'],
    onHelloOk: () => resolve(),
    onConnectError: reject,
    onEvent: (event) => {
      events.push(event);
      traceEvent(event);
    },
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
  assert.equal(await contents(checkFile), '', 'setup checks ran without approval');
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
  await Promise.all([rm(checkFile, { force: true }), rm(applyFile, { force: true })]);
  const sessionKey: string = `agent:${agentId}:lifecycle-${randomUUID()}`;
  activeSessionKey = sessionKey;
  activeRunId = undefined;
  approvalIds.clear();
  process.stdout.write(`${JSON.stringify({ agentId, ...testCase, sessionKey })}\n`);
  const message = `Call ${testCase.toolName} exactly once with {"timeoutMs":600000} for this active agent. Discover the native OpenClaw tool if necessary. Do not invoke shell commands, another agent, or any other lifecycle tool. Let OpenClaw present its approval; after the tool finishes or is blocked, stop without retrying. This is an approval-boundary acceptance test.`;
  const accepted = await client!.request<{ runId: string }>('chat.send', {
    sessionKey,
    message,
    idempotencyKey: randomUUID(),
  });
  activeRunId = accepted.runId;
  const approval = await waitFor(() => approvalFor(sessionKey)[0], 'originating chat approval');
  assert.equal(approval.request.toolName, testCase.toolName);
  assert.equal(approval.request.agentId, agentId);
  assert.deepEqual(approval.request.allowedDecisions, ['allow-once', 'deny']);
  assert.ok(approval.request.description.includes(agentId));
  assert.match(approval.request.description, /Manifest [a-f0-9]{12}/);
  await assertUntouched();
  await client!.request('plugin.approval.resolve', {
    id: approval.id,
    decision: testCase.decision,
  });
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
  const checkRan = (await contents(checkFile)).includes('checked');
  const applyRan = await stat(applyFile).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
  process.stdout.write(
    `${JSON.stringify({
      sessionKey,
      approvalEvents: approvalFor(sessionKey).length,
      uniqueApprovals: approvalIds.size,
      checkRan,
      applyRan,
    })}\n`,
  );
  assert.equal(approvalFor(sessionKey).length, 1, 'unexpected lifecycle retry');
  if (testCase.decision === 'allow-once') {
    assert.ok(checkRan, 'approved checks did not run');
    if (testCase.toolName === 'agent_system_doctor') {
      assert.equal(applyRan, false, 'Doctor applied setup state');
    } else await readFile(applyFile);
  } else await assertUntouched();
  process.stdout.write(`${agentId} ${testCase.toolName} ${testCase.decision}: verified\n`);
} finally {
  await client!.stopAndWait();
  await Promise.all([rm(checkFile, { force: true }), rm(applyFile, { force: true })]);
}
