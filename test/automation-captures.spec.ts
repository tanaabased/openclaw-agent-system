import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  nativeAutomation,
  nativeAutomationHistory,
  nativeAutomationRun,
  type AutomationGateway,
} from '../agent/automation-gateway.ts';
import { nativeAutomationHash } from '../agent/automation-projection.ts';
import type { CliCapture } from '../scripts/cli-fixtures.ts';

interface RpcCapture {
  method: Parameters<AutomationGateway>[0];
  params: Record<string, unknown>;
  response: Record<string, unknown>;
}
interface Capture {
  rpc: RpcCapture[];
  cli: (CliCapture & { executable: string; argv: string[] })[];
}
const fixture = 'fixtures/openclaw-automations.approved.txt';
const capture = async () => JSON.parse(await readFile(fixture, 'utf8')) as Capture;

describe('agent/automation-reviewed-captures', () => {
  it('should preserve real create and changed sync settings through native readback', async () => {
    const recorded = await capture();
    const added = recorded.rpc.find(
      ({ method, params }) => method === 'cron.add' && params.name === 'Agent System: capture',
    )!;
    assert.ok(added);
    const job = nativeAutomation(added.response.job ?? added.response);
    assert.equal(nativeAutomationHash(job), nativeAutomationHash(added.params));
    assert.equal(job.enabled, false);
    const changed = recorded.rpc.find(
      ({ method, params }) =>
        method === 'cron.update' &&
        (params.patch as { schedule?: { everyMs?: number } }).schedule?.everyMs === 7200000,
    )!;
    assert.ok(changed);
    assert.equal(nativeAutomation(changed.response).schedule.everyMs, 7200000);
    assert.equal(typeof changed.params.expectedConfigRevision, 'string');
  });

  it('should distinguish actual execution failure from delivery failure without exposing diagnostics', async () => {
    const recorded = await capture();
    for (const run of recorded.rpc.filter(({ method }) => method === 'cron.run'))
      assert.equal(nativeAutomationRun(run.response).status, 'queued');
    const histories = recorded.rpc
      .filter(({ method }) => method === 'cron.runs')
      .map(({ params, response }) =>
        nativeAutomationHistory(response, String(params.id), {
          limit: Number(params.limit),
          offset: Number(params.offset),
          ...(typeof params.runId === 'string' ? { runId: params.runId } : {}),
        }),
      );
    const entries = histories.flatMap(({ entries }) => entries);
    assert.ok(entries.some(({ execution }) => execution === 'error'));
    assert.ok(
      entries.some(({ execution, delivery }) => execution === 'ok' && delivery === 'not-delivered'),
    );
    assert.ok(entries.every((entry) => !('error' in entry) && !('summary' in entry)));
  });

  it('should retain actual cli arguments streams exits and separate capture provenance', async () => {
    const recorded = await capture();
    for (const cli of recorded.cli) {
      assert.equal(cli.executable, 'openclaw');
      assert.equal(cli.timedOut, false);
      assert.equal(cli.truncated, false);
      assert.ok(['agent-system', 'as'].includes(cli.argv[0]!));
      assert.equal(cli.argv[1], 'automations');
    }
    const syncs = recorded.cli.filter(({ argv }) => argv[2] === 'sync');
    assert.ok(
      syncs.some(({ stdout }) =>
        JSON.parse(stdout).outcomes.some(({ status }: { status: string }) => status === 'updated'),
      ),
    );
    assert.ok(
      syncs.some(({ stdout }) =>
        JSON.parse(stdout).outcomes.every(
          ({ status }: { status: string }) => status === 'unchanged',
        ),
      ),
    );
    const missing = recorded.cli.find(({ argv }) => argv[2] === 'run' && argv[3] === 'missing')!;
    assert.equal(missing.exitCode, 1);
    assert.equal(JSON.parse(missing.stdout).code, 'automation-id-missing');
    assert.match(missing.stderr, /automation-id-missing/u);
    assert.ok(recorded.cli.some(({ argv, exitCode }) => argv.includes('--help') && exitCode === 0));
    const metadata = JSON.parse(await readFile('fixtures/openclaw-automations.meta.json', 'utf8'));
    assert.equal(
      createHash('sha256')
        .update(await readFile(fixture))
        .digest('hex'),
      metadata.sha256,
    );
  });
});
