import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'smol-toml';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export class CodexAutomationError extends Error {
  override name = 'CodexAutomationError';
  constructor(readonly code: string) {
    super(code);
  }
}

const text = Type.String({ minLength: 1, pattern: '^[^\\u0000]+$' });
export const effortSchema = Type.Union(
  ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((v) => Type.Literal(v)),
);
const common = {
  name: text,
  prompt: text,
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('PAUSED')]),
  rrule: text,
  notificationPolicy: Type.Union([Type.Null(), Type.Literal('failed_runs_only')]),
};
export const nativeAutomationSchema = Type.Union([
  Type.Object(
    {
      ...common,
      kind: Type.Literal('cron'),
      destination: Type.Literal('local'),
      executionEnvironment: Type.Literal('local'),
      projectId: Type.Union([text, Type.Null()]),
      model: text,
      reasoningEffort: effortSchema,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...common,
      kind: Type.Literal('heartbeat'),
      destination: Type.Literal('thread'),
      targetThreadId: text,
    },
    { additionalProperties: false },
  ),
]);
export type NativeAutomation = Static<typeof nativeAutomationSchema>;
export interface SavedAutomation {
  id: string;
  definition: NativeAutomation;
  cwds?: string[];
}
const savedCommon = {
  version: Type.Literal(1),
  id: text,
  name: text,
  prompt: text,
  status: common.status,
  rrule: text,
  notification_policy: Type.Optional(Type.Literal('failed_runs_only')),
  created_at: Type.Number(),
  updated_at: Type.Number(),
};
const savedSchema = Type.Union([
  Type.Object(
    {
      ...savedCommon,
      kind: Type.Literal('cron'),
      model: text,
      reasoning_effort: effortSchema,
      execution_environment: Type.Literal('local'),
      target: Type.Union([
        Type.Object(
          { type: Type.Literal('project'), project_id: text },
          { additionalProperties: false },
        ),
        Type.Object({ type: Type.Literal('projectless') }, { additionalProperties: false }),
      ]),
      cwds: Type.Array(text, { minItems: 1, maxItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { ...savedCommon, kind: Type.Literal('heartbeat'), target_thread_id: text },
    { additionalProperties: false },
  ),
]);

/** normalize recorded native settings; a view acknowledgment is not a snapshot. */
export function parseSavedAutomation(contents: string, id: string): SavedAutomation {
  let value: unknown;
  try {
    value = parse(contents);
  } catch {
    throw new CodexAutomationError('automation-saved-invalid');
  }
  if (!Value.Check(savedSchema, value) || value.id !== id) {
    throw new CodexAutomationError('automation-saved-schema-unsupported');
  }
  const shared = {
    name: value.name,
    prompt: value.prompt,
    status: value.status,
    rrule: value.rrule.replace(/^RRULE:/u, ''),
    notificationPolicy: value.notification_policy ?? null,
  };
  return {
    id,
    ...(value.kind === 'cron' ? { cwds: value.cwds } : {}),
    definition:
      value.kind === 'cron'
        ? {
            ...shared,
            kind: 'cron',
            destination: 'local',
            executionEnvironment: 'local',
            projectId: value.target.type === 'project' ? value.target.project_id : null,
            model: value.model,
            reasoningEffort: value.reasoning_effort,
          }
        : {
            ...shared,
            kind: 'heartbeat',
            destination: 'thread',
            targetThreadId: value.target_thread_id,
          },
  };
}

/** bounded, no-follow reads; inspection never creates directories or repairs state. */
export async function readCodexFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid file');
    const bytes = await file.readFile();
    if (bytes.length > 1024 * 1024) throw new Error('invalid file');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    await file.close();
  }
}

export async function readCodexAutomations(codexHome: string): Promise<SavedAutomation[]> {
  const root = join(codexHome, 'automations');
  try {
    if (!(await lstat(root)).isDirectory()) throw new Error('invalid directory');
    const entries = await readdir(root, { withFileTypes: true });
    if (entries.length > 2000) throw new Error('too many records');
    const result: SavedAutomation[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error('symlink');
      if (!entry.isDirectory()) continue;
      let contents: string;
      try {
        contents = await readCodexFile(join(root, entry.name, 'automation.toml'));
      } catch (error) {
        // native deletion retains run memory without a definition.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      const saved = parseSavedAutomation(contents, entry.name);
      if (saved.cwds)
        saved.cwds = await Promise.all(saved.cwds.map((cwd) => realpath(cwd).catch(() => cwd)));
      result.push(saved);
    }
    return result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (error instanceof CodexAutomationError) throw error;
    throw new CodexAutomationError('automation-saved-inspection-failed');
  }
}

export async function readCodexAutomationDefaults(codexHome: string) {
  try {
    const config = parse(await readCodexFile(join(codexHome, 'config.toml')));
    if (config.profile !== undefined) throw new Error('profile requires explicit defaults');
    const model = config.model;
    const effort = config.model_reasoning_effort;
    if (typeof model !== 'string' || !model.trim() || !Value.Check(effortSchema, effort)) {
      throw new Error('missing defaults');
    }
    return { model, effort };
  } catch {
    throw new CodexAutomationError('automation-profile-defaults-unavailable');
  }
}

/** only structured native receipts identify a completed request; readback remains mandatory. */
export function parseAutomationReceipt(value: unknown, mode: 'create' | 'update'): string {
  const schema = Type.Object({
    content: Type.Array(Type.Object({ type: Type.String(), text: Type.Optional(Type.String()) })),
    isError: Type.Optional(Type.Boolean()),
  });
  if (!Value.Check(schema, value) || value.isError)
    throw new CodexAutomationError('automation-native-write-failed');
  const receipts = value.content.flatMap((item) => {
    if (item.type !== 'text' || !item.text) return [];
    try {
      const receipt: unknown = JSON.parse(item.text);
      const shape = Type.Object({
        automationId: text,
        mode: Type.Literal(mode),
        status: common.status,
      });
      return Value.Check(shape, receipt) ? [receipt.automationId] : [];
    } catch {
      return [];
    }
  });
  if (receipts.length !== 1) throw new CodexAutomationError('automation-native-receipt-missing');
  return receipts[0]!;
}
