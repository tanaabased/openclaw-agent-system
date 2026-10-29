import assert from 'node:assert/strict';
import prepareDispatchReport from '../agent/codex-dispatch-report.ts';
import openclawIntakeReport from '../agent/openclaw-intake-report.ts';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import CodexDispatchStore, {
  type DispatchRecord,
  type DispatchState,
} from '../agent/codex-dispatch-state.ts';
import type DispatchStore from '../agent/dispatch-state.ts';
import type { SharedDispatchRecord } from '../agent/dispatch-state.ts';
import OpenClawDispatchStore, {
  type OpenClawDispatchState,
} from '../agent/openclaw-dispatch-state.ts';
import { dispatchStorageBytes, dispatchStorageNotice } from '../agent/dispatch-storage.ts';

// Opt-in synthetic journal measurement. Never reads or changes installed runtime state.
const mib = 1024 * 1024;
const size = Number(process.argv[2]);
if (!size) {
  for (const runtime of ['codex', 'openclaw'])
    for (const value of [2, 16, 32, 64]) {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', fileURLToPath(import.meta.url), String(value), runtime],
        { encoding: 'utf8' },
      );
      process.stdout.write(child.stdout);
      process.stderr.write(child.stderr);
      assert.equal(child.status, 0);
    }
} else {
  const runtime = process.argv[3];
  const scope = 'a'.repeat(64);
  const root = await mkdtemp(join(tmpdir(), 'dispatch-storage-measure-'));
  const store = (
    runtime === 'codex'
      ? new CodexDispatchStore(root, scope)
      : new OpenClawDispatchStore(root, scope)
  ) as DispatchStore<SharedDispatchRecord>;
  try {
    const state: DispatchState = { version: 1, scope, resetGeneration: 'initial', records: [] };
    const make = (index: number, length: number): DispatchRecord => ({
      id: index.toString(16).padStart(64, '0'),
      intakeId: index.toString(16).padStart(64, '0'),
      issueKey: index.toString(16).padStart(64, '0'),
      sourceThreadId: 'synthetic',
      phase: 'routing',
      createdAt: 1,
      manifestDigest: 'manifest',
      context: 'x'.repeat(length),
    });
    const target = size * mib + (size === 16 || size === 32 ? 4096 : -4096);
    const overhead = Buffer.byteLength(JSON.stringify(make(1, 0))) + 1;
    let bytes = Buffer.byteLength(JSON.stringify(state));
    while (bytes + overhead < target) {
      const length = Math.min(96000, target - bytes - overhead);
      const record = make(state.records.length + 1, length);
      state.records.push(record);
      bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
    }
    const originalPressure = dispatchStorageNotice(state).level;
    const beforeMemory = process.memoryUsage().rss;
    const start = performance.now();
    const serialized = dispatchStorageBytes(state);
    const serializationMs = performance.now() - start;
    await writeFile(store.path, serialized.contents, { mode: 0o600 });
    const writeStart = performance.now();
    await store.exclusive(async (current, save) => {
      current.records[0]!.routingNote = 'existing assessment can save';
      await save();
    });
    const rewriteMs = performance.now() - writeStart;
    const rewriteRssMiB = Math.round(process.memoryUsage().rss / mib);
    const committed = await readFile(store.path, 'utf8');
    if (size >= 32) {
      await assert.rejects(
        store.exclusive(async (current, save) => {
          current.records.push(make(9999, 1));
          await save();
        }),
        /dispatch-storage-admission-paused/,
      );
      assert.equal(await readFile(store.path, 'utf8'), committed);
    }
    if (size === 64) {
      await assert.rejects(
        store.exclusive(async (current, save) => {
          current.records.at(-1)!.context = 'x'.repeat(96000);
          await save();
        }),
        /dispatch-state-capacity/,
      );
      assert.equal(await readFile(store.path, 'utf8'), committed);
      await assert.rejects(
        store.exclusive(async (current, save) => {
          current.run = {
            id: 'run',
            automationId: 'synthetic',
            currentTimeIso: 'now',
            actions: 0,
            response: '\u0000'.repeat(128000),
          };
          current.intakeReport = {
            fingerprint: scope,
            problems: [],
            runId: 'run',
            response: '\u0000'.repeat(128000),
          };
          await save();
        }),
        /dispatch-state-capacity/,
      );
      assert.equal(await readFile(store.path, 'utf8'), committed);
      // A within-file-ceiling legacy journal can be read and reduced by supported reconciliation.
      const legacy = JSON.parse(committed) as DispatchState;
      const retired = make(9999, 96000);
      retired.retired = { at: Date.now(), by: 'synthetic' };
      retired.retirement = {
        reason: 'issue-closed',
        intakeId: retired.id,
        at: retired.retired.at,
        checkedAt: retired.retired.at,
        eligibleAt: retired.retired.at,
        archivedAt: retired.retired.at,
        worktreeRemovedAt: retired.retired.at,
      };
      legacy.records.push(retired);
      assert.ok(dispatchStorageBytes(legacy).contentBytes > 64 * mib);
      await writeFile(store.path, JSON.stringify(legacy), { mode: 0o600 });
      await store.reconcile();
      assert.ok(dispatchStorageBytes(await store.read()).contentBytes < 64 * mib);
    }
    if (size === 16) {
      const intake = {
        version: 1 as const,
        scope,
        workspaceDir: '/synthetic',
        agentId: 'synthetic',
        account: { login: 'synthetic', nodeId: 'synthetic' },
        policyDigest: scope,
        baselineAt: 0,
        records: [],
      };
      const input = {
        state,
        intake,
        slots: 3,
        automationId: 'synthetic',
        currentTimeIso: '2026-10-29T12:00:00.000Z',
      };
      const first = prepareDispatchReport(input);
      assert.match(first.response, /NOTIFY/);
      assert.doesNotMatch(first.response, /DONT_NOTIFY/);
      state.intakeHealth = first.health;
      state.intakeHealthVersion = 1;
      assert.match(prepareDispatchReport(input).response, /DONT_NOTIFY/);
      const openState = { ...state, records: state.records } as unknown as OpenClawDispatchState;
      const openInput = {
        state: openState,
        slots: 3,
        observation: { status: 'ready' as const, changed: false },
      };
      const report = openclawIntakeReport(openInput);
      assert.equal(report.changed, true);
      openState.intakeReport = { ...report, runId: 'run' };
      assert.equal(openclawIntakeReport(openInput).changed, false);
      state.records = [];
      assert.doesNotMatch(prepareDispatchReport(input).response, /DONT_NOTIFY/);
      state.intakeHealth = prepareDispatchReport(input).health;
      assert.match(prepareDispatchReport(input).response, /DONT_NOTIFY/);
      openState.records = [];
      assert.equal(openclawIntakeReport(openInput).changed, true);
      openState.intakeReport = { ...openclawIntakeReport(openInput), runId: 'cleared' };
      assert.equal(openclawIntakeReport(openInput).changed, false);
    }
    if (size === 32) {
      const concurrent = JSON.parse(committed) as DispatchState;
      concurrent.records.at(-1)!.context = concurrent.records.at(-1)!.context!.slice(0, -8200);
      await writeFile(store.path, JSON.stringify(concurrent), { mode: 0o600 });
      await store.transaction(async (current, save) => {
        current.records.push(make(9998, 2500));
        await store.exclusive(async (fresh, commit) => {
          fresh.records.push(make(9999, 2500));
          await commit();
        });
        await assert.rejects(save(), /dispatch-storage-admission-paused/);
      });
      const saved = await store.read();
      assert.ok(saved.records.some((record) => record.id === make(9999, 0).id));
      assert.ok(!saved.records.some((record) => record.id === make(9998, 0).id));
    }
    const afterMemory = process.memoryUsage().rss;
    process.stdout.write(
      JSON.stringify({
        runtime,
        sizeMiB: size,
        contentBytes: serialized.contentBytes,
        serializationMs: Math.round(serializationMs),
        rewriteMs: Math.round(rewriteMs),
        rewriteRssMiB,
        rssBeforeMiB: Math.round(beforeMemory / mib),
        rssAfterMiB: Math.round(afterMemory / mib),
        peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
        pressure: originalPressure,
      }) + '\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
