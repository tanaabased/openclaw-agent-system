import { realpath } from 'node:fs/promises';

import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import { automationHash } from './automation-hash.ts';
import codexAutomationSchedule from './codex-automation-schedule.ts';
import {
  CodexAutomationError,
  effortSchema,
  nativeAutomationSchema,
  type NativeAutomation,
  type SavedAutomation,
} from './codex-automation-state.ts';
import automationContent from '../manifest/automation-content.ts';
import type { ResolvedAutomation } from '../manifest/automation-schema.ts';

const text = Type.String({ minLength: 1 });
export const automationRecordSchema = Type.Object(
  {
    id: text,
    nativeId: text,
    removed: Type.Boolean(),
    definition: nativeAutomationSchema,
  },
  { additionalProperties: false },
);
export type CodexAutomationRecord = Static<typeof automationRecordSchema>;
export interface CodexAutomationAction {
  manifestId: string;
  mode: 'create' | 'update';
  id?: string;
  expected: NativeAutomation;
  removed: boolean;
}
export interface CodexAutomationInputs {
  projects?: unknown;
  threads?: unknown[];
}
export interface CodexAutomationPlan {
  status: 'aligned' | 'requires-native-app-sync' | 'blocked';
  digest: string;
  actions: CodexAutomationAction[];
  findings: { id: string; code: string }[];
  unmanagedCount: number;
  telemetry: { execution: 'unavailable'; delivery: 'unavailable' };
}

export function codexAutomationMarker(scope: string, id: string): string {
  return `Managed by Agent System (codex:${scope}:${id}).`;
}

export function savedMatches(
  actual: SavedAutomation,
  expected: NativeAutomation,
  workspace: string,
) {
  return (
    automationHash(actual.definition) === automationHash(expected) &&
    (expected.kind !== 'cron' || automationHash(actual.cwds) === automationHash([workspace]))
  );
}

async function projectId(input: unknown, workspace: string): Promise<string> {
  const schema = Type.Object({
    schemaVersion: Type.Literal(2),
    projects: Type.Array(
      Type.Object({
        projectId: text,
        projectKind: Type.String(),
        path: Type.Optional(Type.String()),
        hostId: Type.Union([Type.String(), Type.Null()]),
      }),
    ),
  });
  if (!Value.Check(schema, input)) throw new CodexAutomationError('automation-projects-required');
  const matches = [];
  for (const project of input.projects) {
    if (project.projectKind !== 'local' || project.hostId !== 'local' || !project.path) continue;
    try {
      if ((await realpath(project.path)) === workspace) matches.push(project.projectId);
    } catch {
      /* unrelated unavailable projects do not establish a binding. */
    }
  }
  if (matches.length !== 1) throw new CodexAutomationError('automation-project-binding-ambiguous');
  return matches[0]!;
}

async function verifyThread(inputs: unknown[], id: string, workspace: string): Promise<void> {
  const schema = Type.Object({
    schemaVersion: Type.Literal(1),
    thread: Type.Object({
      id: text,
      kind: Type.Literal('codex'),
      hostId: Type.Literal('local'),
      cwd: text,
      status: Type.Object({ type: Type.String() }),
    }),
  });
  const matches = inputs.filter((input) => Value.Check(schema, input) && input.thread.id === id);
  if (matches.length !== 1 || !Value.Check(schema, matches[0])) {
    throw new CodexAutomationError('automation-thread-verification-required');
  }
  const thread = matches[0].thread;
  if (
    !['idle', 'active', 'running', 'completed'].includes(thread.status.type) ||
    (await realpath(thread.cwd).catch(() => '')) !== workspace
  ) {
    throw new CodexAutomationError('automation-thread-workspace-mismatch');
  }
}

/** the model supplies native lookup results, never desired jobs, ownership, or the diff. */
export default async function planCodexAutomations(options: {
  scope: string;
  workspace: string;
  agentId: string;
  manifestDigest: string;
  jobs: ResolvedAutomation[];
  saved: SavedAutomation[];
  records: CodexAutomationRecord[];
  inputs: CodexAutomationInputs;
  defaults?: { model: string; effort: string };
}): Promise<CodexAutomationPlan> {
  const { scope, workspace, jobs, records, saved, inputs } = options;
  const findings: CodexAutomationPlan['findings'] = [];
  const actions: CodexAutomationAction[] = [];
  const ids = new Set<string>();
  const owned = new Map<string, SavedAutomation>();
  const prefix = `Managed by Agent System (codex:${scope}:`;
  for (const item of saved) {
    if (ids.has(item.id)) throw new CodexAutomationError('automation-native-id-duplicate');
    ids.add(item.id);
    if (!item.definition.prompt.includes(prefix)) continue;
    const markers = item.definition.prompt.split('\n').filter((line) => line.startsWith(prefix));
    const match =
      markers.length === 1
        ? /^Managed by Agent System \(codex:[a-f0-9]{64}:([a-z0-9]+(?:-[a-z0-9]+)*)\)\.$/u.exec(
            markers[0]!,
          )
        : null;
    if (!match || owned.has(match[1]!))
      throw new CodexAutomationError('automation-ownership-conflict');
    owned.set(match[1]!, item);
  }
  if (
    new Set(records.map((record) => record.id)).size !== records.length ||
    new Set(records.map((record) => record.nativeId)).size !== records.length
  ) {
    throw new CodexAutomationError('automation-ownership-conflict');
  }
  for (const [id] of owned)
    if (!records.some((record) => record.id === id)) {
      findings.push({ id, code: 'automation-ownership-recovery-required' });
    }
  const applicable = jobs.filter((job) => job.runtimes.includes('codex'));
  const declaredIds = new Set(applicable.map((job) => job.id));
  for (const job of applicable) {
    try {
      if (job.payload.kind !== 'prompt')
        throw new CodexAutomationError('automation-command-unsupported');
      if (job.timeoutSeconds !== undefined)
        throw new CodexAutomationError('automation-timeout-unsupported');
      if (job.payload.prompt.includes('Managed by Agent System (codex:')) {
        throw new CodexAutomationError('automation-prompt-marker-conflict');
      }
      const rrule = codexAutomationSchedule(job.schedule);
      const override = job.overrides.codex;
      const target = override?.target ?? 'independent';
      const record = records.find((r) => r.id === job.id);
      const actual = owned.get(job.id);
      if (record && (!actual || actual.id !== record.nativeId)) {
        throw new CodexAutomationError('automation-native-recovery-required');
      }
      if (!record && actual) continue;
      const common = {
        name: `${options.agentId}: ${job.id}`,
        prompt: `${job.payload.prompt}\n\n${codexAutomationMarker(scope, job.id)}`,
        rrule,
        status: job.enabled ? ('ACTIVE' as const) : ('PAUSED' as const),
        notificationPolicy: actual?.definition.notificationPolicy ?? null,
      };
      let expected: NativeAutomation;
      if (target !== 'independent') {
        if (override?.model !== undefined || override?.effort !== undefined) {
          throw new CodexAutomationError('automation-thread-overrides-unsupported');
        }
        await verifyThread(inputs.threads ?? [], target.thread, workspace);
        expected = {
          ...common,
          kind: 'heartbeat',
          destination: 'thread',
          targetThreadId: target.thread,
        };
      } else {
        const model = override?.model ?? options.defaults?.model;
        const effort = override?.effort ?? options.defaults?.effort;
        if (!model || !Value.Check(effortSchema, effort))
          throw new CodexAutomationError('automation-profile-defaults-unavailable');
        expected = {
          ...common,
          kind: 'cron',
          destination: 'local',
          executionEnvironment: 'local',
          projectId: await projectId(inputs.projects, workspace),
          model,
          reasoningEffort: effort,
        };
      }
      if (actual && actual.definition.kind !== expected.kind) {
        throw new CodexAutomationError('automation-target-migration-required');
      }
      if (!actual || !savedMatches(actual, expected, workspace) || record?.removed) {
        actions.push({
          manifestId: job.id,
          mode: actual ? 'update' : 'create',
          ...(actual ? { id: actual.id } : {}),
          expected,
          removed: false,
        });
        findings.push({ id: job.id, code: actual ? 'automation-drift' : 'automation-missing' });
      } else
        findings.push({
          id: job.id,
          code: job.enabled ? 'automation-healthy' : 'automation-disabled',
        });
    } catch (error) {
      findings.push({
        id: job.id,
        code: error instanceof CodexAutomationError ? error.code : 'automation-projection-failed',
      });
    }
  }
  for (const record of records) {
    if (declaredIds.has(record.id)) continue;
    const actual = owned.get(record.id);
    if (!actual || actual.id !== record.nativeId) {
      findings.push({ id: record.id, code: 'automation-native-recovery-required' });
      continue;
    }
    if (actual.definition.status !== 'PAUSED' || !record.removed) {
      actions.push({
        manifestId: record.id,
        mode: 'update',
        id: actual.id,
        expected: { ...actual.definition, status: 'PAUSED' },
        removed: true,
      });
      findings.push({ id: record.id, code: 'automation-removal-pending' });
    } else findings.push({ id: record.id, code: 'automation-disabled-retained' });
  }
  const ordinary = new Set([
    'automation-healthy',
    'automation-disabled',
    'automation-disabled-retained',
    'automation-missing',
    'automation-drift',
    'automation-removal-pending',
  ]);
  const blocked = findings.some((finding) => !ordinary.has(finding.code));
  const digest = automationHash({
    version: 1,
    scope,
    workspace,
    manifestDigest: options.manifestDigest,
    desired: applicable.map((job) => automationContent(job, 'codex', options.defaults).content),
    saved,
    records,
    actions,
    findings,
  });
  return {
    status: blocked ? 'blocked' : actions.length ? 'requires-native-app-sync' : 'aligned',
    digest,
    actions: blocked ? [] : actions,
    findings,
    unmanagedCount: saved.length - owned.size,
    telemetry: { execution: 'unavailable', delivery: 'unavailable' },
  };
}
