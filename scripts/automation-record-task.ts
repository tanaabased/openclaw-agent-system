import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';

import { defaultExecutor } from './cli-fixtures.ts';
import {
  requestAutomationGateway,
  nativeAutomation,
  nativeAutomationHistory,
  nativeAutomationRun,
  type AutomationGateway,
} from '../agent/automation-gateway.ts';
import AutomationService from '../agent/automation-service.ts';
import discoverManifest from '../manifest/discover.ts';
import { loadDiscoveredManifest } from '../manifest/load.ts';

// opt-in only, on an isolated github actions runner; never record during ordinary ci.
if (process.env.GITHUB_ACTIONS !== 'true' || process.argv[2] !== '--record' || !process.argv[3])
  throw new Error('Use --record <directory> in isolated GitHub Actions.');
const directory = process.argv[3];
const workspace = await realpath(join(process.env.TMPDIR!, 'automation-agent'));
const profile = resolveStateDir();
const captures: object[] = [];
const cliCaptures: object[] = [];
const replacements = new Map<string, string>([
  [workspace, '/workspace/fixture'],
  [profile, '/profile/fixture'],
]);
let nextId = 0;
function ids(value: unknown) {
  if (Array.isArray(value)) {
    value.forEach(ids);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (
      ['id', 'runId'].includes(key) &&
      typeof item === 'string' &&
      ![
        'capture',
        'identity',
        'paused-review',
        'prompt',
        'stale',
        'containment',
        'policy',
        'missing',
        'timeout',
        'cancel',
        'disabled',
      ].includes(item) &&
      !replacements.has(item)
    )
      replacements.set(item, `${key === 'id' ? 'native' : 'run'}-${++nextId}`);
    else ids(item);
  }
}
const request: AutomationGateway = async (method, params) => {
  const response = await requestAutomationGateway(method, params);
  ids(response);
  captures.push({ method, params: structuredClone(params), response: structuredClone(response) });
  return response;
};
const initial = await requestAutomationGateway('cron.list', {
  includeDisabled: true,
  limit: 200,
  offset: 0,
  includeDeliveryPreviews: false,
});
const runner = (initial.jobs as { payload: { kind: string; argv?: string[] } }[]).find(
  (job) => job.payload.kind === 'command' && job.payload.argv?.includes('automation-execute'),
)?.payload.argv;
assert.ok(runner);
const command = runner.slice(0, runner.indexOf('agent-system'));
const service = new AutomationService({
  root: join(profile, 'agent-system-automations'),
  profile,
  command,
  environment: Object.fromEntries(
    ['OPENCLAW_PROFILE', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'].flatMap((name) =>
      process.env[name] ? [[name, process.env[name]!]] : [],
    ),
  ),
  request,
  manifestService: {
    loadForAgentId: async () =>
      loadDiscoveredManifest(await discoverManifest(workspace), {
        expectedAgentId: 'automation-tanaabot',
      }),
  },
});
const load = async () => {
  const loaded = await loadDiscoveredManifest(await discoverManifest(workspace), {
    expectedAgentId: 'automation-tanaabot',
  });
  assert.equal(loaded.status, 'loaded');
  if (loaded.status !== 'loaded') throw new Error('Invalid capture manifest.');
  return loaded.manifest;
};
const { store } = await service.scope(await load(), workspace);
replacements.set(store.scope, 'fixture-scope');
command.forEach((part, index) =>
  replacements.set(part, index === 0 ? '/runtime/node' : '/runtime/openclaw.mjs'),
);
const fixture =
  '- id: capture\n  runtimes: [openclaw]\n  schedule: every 1 hour\n  run: [sh, ./capture.sh]\n';
const created: string[] = [];
const manifestPath = join(workspace, 'automations.yaml');
const original = await readFile(manifestPath);
function cli(argv: string[]) {
  const before = process.cwd();
  process.chdir(workspace);
  try {
    const capture = defaultExecutor('openclaw', argv);
    assert.equal(capture.timedOut, false);
    assert.equal(capture.truncated, false);
    if (capture.stdout.trim()) {
      try {
        ids(JSON.parse(capture.stdout));
      } catch {
        /* help output is text. */
      }
    }
    cliCaptures.push({ executable: 'openclaw', argv, ...capture });
    return capture;
  } finally {
    process.chdir(before);
  }
}
async function finished(runId: string) {
  for (let n = 0; n < 90; n++) {
    const history = await service.runs(await load(), workspace, 'capture', {
      limit: 1,
      offset: 0,
      runId,
    });
    if (history.entries.length) return history;
    await Bun.sleep(2000);
  }
  throw new Error('Capture occurrence did not finish.');
}
try {
  await writeFile(join(workspace, 'capture.sh'), '#!/bin/sh\nprintf "captured success\\n"\n');
  await writeFile(manifestPath, fixture);
  await service.reconcile(await load(), workspace);
  const synchronized = await service.reconcile(await load(), workspace);
  assert.ok(synchronized.outcomes.every(({ status }) => status === 'unchanged'));
  assert.equal(cli(['agent-system', 'automations', 'sync', '--json']).exitCode, 0);
  const run = await service.run(await load(), workspace, 'capture');
  assert.equal(run.status, 'queued');
  assert.equal((await finished(run.runId!)).entries[0]!.execution, 'ok');
  assert.equal(
    cli(['as', 'automations', 'runs', 'capture', '--run-id', run.runId!, '--limit', '1', '--json'])
      .exitCode,
    0,
  );
  await writeFile(join(workspace, 'capture.sh'), '#!/bin/sh\nexit 7\n');
  const failure = await service.run(await load(), workspace, 'capture');
  assert.equal((await finished(failure.runId!)).entries[0]!.execution, 'error');
  assert.equal(cli(['agent-system', 'automations', 'list', '--json']).exitCode, 1);
  assert.equal(cli(['as', 'automations', 'run', 'missing', '--json']).exitCode, 1);
  const cliRun = cli(['as', 'automations', 'run', 'capture', '--json']);
  assert.equal(cliRun.exitCode, 0);
  await finished(JSON.parse(cliRun.stdout).runId);
  await writeFile(manifestPath, fixture.replace('every 1 hour', 'every 2 hours'));
  assert.ok(
    (await service.reconcile(await load(), workspace)).outcomes.some(
      ({ stepId, status }) => stepId === 'capture' && status === 'updated',
    ),
  );
  await writeFile(manifestPath, fixture.replace('every 1 hour', 'every 3 hours'));
  assert.equal(cli(['as', 'automations', 'sync', '--json']).exitCode, 0);
  await service.reconcile(await load(), workspace);
  // a raw disabled native fixture isolates delivery failure without weakening owned-job drift checks.
  await writeFile(
    join(workspace, 'capture.sh'),
    '#!/bin/sh\nprintf "delivery fixture success\\n"\n',
  );
  const deliveryJob = await request('cron.add', {
    name: 'capture-delivery',
    agentId: 'automation-tanaabot',
    enabled: false,
    schedule: { kind: 'every', everyMs: 3600000 },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'command',
      argv: ['sh', join(workspace, 'capture.sh')],
      cwd: workspace,
      timeoutSeconds: 10,
    },
    delivery: {
      mode: 'webhook',
      to: 'http://127.0.0.1:1/automation-197-unavailable',
      bestEffort: false,
    },
  });
  const deliveryId = nativeAutomation(deliveryJob.job ?? deliveryJob).id;
  created.push(deliveryId);
  const deliveryRun = nativeAutomationRun(
    await request('cron.run', { id: deliveryId, mode: 'force' }),
  );
  assert.equal(deliveryRun.status, 'queued');
  let deliveryFailed = false;
  for (let n = 0; n < 90; n++) {
    const options = { limit: 1, offset: 0, runId: deliveryRun.runId! };
    const history = nativeAutomationHistory(
      await request('cron.runs', { id: deliveryId, ...options }),
      deliveryId,
      options,
    );
    if (history.entries.length) {
      assert.equal(history.entries[0]!.execution, 'ok');
      assert.equal(history.entries[0]!.delivery, 'not-delivered');
      deliveryFailed = true;
      break;
    }
    await Bun.sleep(2000);
  }
  assert.ok(deliveryFailed, 'Native delivery failure was not observed.');
  // disabled unmanaged jobs establish real production pagination without scheduled payloads.
  for (let n = 0; n < 201; n++) {
    const added = await requestAutomationGateway('cron.add', {
      name: `capture-unmanaged-${n}`,
      enabled: false,
      schedule: { kind: 'every', everyMs: 3600000 },
      sessionTarget: 'isolated',
      wakeMode: 'now',
      payload: { kind: 'agentTurn', message: 'disabled capture fixture' },
      delivery: { mode: 'none' },
    });
    const id = nativeAutomation(added.job ?? added).id;
    created.push(id);
  }
  await service.list(await load(), workspace);
  assert.equal(cli(['agent-system', 'automations', 'list', '--json']).exitCode, 1);
  cli(['as', 'automations', 'run', '--help']);
} finally {
  for (const id of created)
    await callGatewayFromCli(
      'cron.remove',
      { timeout: '10000' },
      { id },
      { progress: false, scopes: ['operator.admin'] },
    );
  await writeFile(manifestPath, original);
  await service.reconcile(await load(), workspace);
}
function sanitize(value: unknown) {
  let text = JSON.stringify(value, null, 2);
  for (const [from, to] of [...replacements].sort(([a], [b]) => b.length - a.length))
    text = text.split(JSON.stringify(from).slice(1, -1)).join(JSON.stringify(to).slice(1, -1));
  return `${text}\n`;
}
await mkdir(directory, { recursive: true });
const contents = sanitize({ rpc: captures, cli: cliCaptures });
await writeFile(join(directory, 'openclaw-automations.received.txt'), contents);
await writeFile(
  join(directory, 'openclaw-automations.received.meta.json'),
  JSON.stringify(
    {
      issue: 197,
      capturedAt: new Date().toISOString(),
      source: 'isolated GitHub Actions opt-in production builders and operator transport',
      runtime: process.version,
      workflowRun: process.env.GITHUB_RUN_ID,
      sha256: createHash('sha256').update(contents).digest('hex'),
      sanitization:
        'Literal identifiers, scoped markers, executable and workspace/profile paths only; response fields retained.',
      boundaries: [
        'Unchanged sync is the absence of native mutation requests, not a fabricated RPC response.',
        'Malformed responses and partial failures are constructed negatives.',
        'Delivery failure uses an explicitly created disabled unmanaged native command with an unreachable loopback webhook. Owned job drift guards are unchanged.',
        'Script file edits do not declare content drift; the changed schedule does.',
        'Capture output is a candidate and requires review before acceptance.',
      ],
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write('Recorded automation candidates for review.\n');
