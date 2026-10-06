import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

import normalizeAutomationSchedule, { type AutomationSchedule } from './automation-schedule.ts';
import {
  commandSchema,
  commandScriptSchema,
  commandShellSchema,
  normalizeCommand,
  unsafeCommandExecutable,
  type NormalizedCommand,
} from './command-schema.ts';
import type { ManifestDiagnostic } from './types.ts';

const textSchema = Type.String({ pattern: '^(?=[\\s\\S]*\\S)[^\\u0000\\r\\n]*(?![\\s\\S])' });
export const automationFileSchema = Type.Object(
  { file: textSchema },
  { additionalProperties: false },
);
const promptSchema = Type.Union([commandScriptSchema, automationFileSchema]);
const overrideSchema = Type.Object(
  {
    model: Type.Optional(textSchema),
    effort: Type.Optional(textSchema),
    target: Type.Optional(
      Type.Union([
        Type.Literal('independent'),
        Type.Object({ thread: textSchema }, { additionalProperties: false }),
      ]),
    ),
  },
  { additionalProperties: false },
);
export const automationThreadSchema = Type.Object(
  { id: Type.Optional(textSchema), name: Type.Optional(textSchema) },
  { additionalProperties: false, minProperties: 1 },
);
const jobSchema = Type.Object(
  {
    id: Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*(?![\\s\\S])' }),
    enabled: Type.Optional(Type.Boolean()),
    thread: Type.Optional(Type.Union([Type.Null(), textSchema, automationThreadSchema])),
    runtimes: Type.Optional(
      Type.Array(Type.Union([Type.Literal('openclaw'), Type.Literal('codex')]), {
        minItems: 1,
        uniqueItems: true,
      }),
    ),
    schedule: Type.Unknown(),
    run: Type.Optional(commandSchema),
    shell: Type.Optional(commandShellSchema),
    prompt: Type.Optional(promptSchema),
    payload: Type.Optional(
      Type.Union([
        Type.Object(
          {
            kind: Type.Literal('command'),
            run: commandSchema,
            shell: Type.Optional(commandShellSchema),
          },
          { additionalProperties: false },
        ),
        Type.Object(
          { kind: Type.Literal('prompt'), prompt: promptSchema },
          { additionalProperties: false },
        ),
      ]),
    ),
    'timeout-seconds': Type.Optional(Type.Integer({ minimum: 1, maximum: 3600 })),
    overrides: Type.Optional(
      Type.Object(
        {
          openclaw: Type.Optional(overrideSchema),
          codex: Type.Optional(overrideSchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const automationListSchema = Type.Array(jobSchema);
export const externalAutomationsSchema = Type.Union([automationListSchema, automationFileSchema]);
export type AutomationRuntime = 'openclaw' | 'codex';
export type AutomationOverride = Static<typeof overrideSchema>;
export interface AgentAutomation {
  id: string;
  enabled: boolean;
  runtimes: AutomationRuntime[];
  schedule: AutomationSchedule;
  payload:
    | { kind: 'command'; run: NormalizedCommand }
    | { kind: 'prompt'; prompt: string | { file: string } };
  thread?: { id?: string; name?: string };
  timeoutSeconds?: number;
  overrides: Partial<Record<AutomationRuntime, AutomationOverride>>;
}
export type ResolvedAutomation = Omit<AgentAutomation, 'payload'> & {
  payload: { kind: 'command'; run: NormalizedCommand } | { kind: 'prompt'; prompt: string };
};

export function automationDiagnostic(code: string, fieldPath: string): ManifestDiagnostic {
  return {
    code,
    fieldPath,
    message: `Invalid automation declaration at ${fieldPath}.`,
    severity: 'error',
  };
}

/** normalize declarations without files, clocks, model calls, or runtime capability checks. */
export default function normalizeAutomations(
  value: unknown,
):
  | { status: 'valid'; automations: AgentAutomation[]; diagnostics: [] }
  | { status: 'invalid'; diagnostics: ManifestDiagnostic[] } {
  if (!Value.Check(automationListSchema, value)) {
    const diagnostics = Value.Errors(automationListSchema, value)
      .filter((error) => !error.schemaPath.includes('/anyOf/'))
      .flatMap((error) =>
        error.keyword === 'additionalProperties'
          ? error.params.additionalProperties.map((key) =>
              automationDiagnostic(
                'manifest-unknown-key',
                `/automations${error.instancePath}/${key.replace(/~/gu, '~0').replace(/\//gu, '~1')}`,
              ),
            )
          : [
              automationDiagnostic(
                'manifest-automation-schema',
                `/automations${error.instancePath}`,
              ),
            ],
      );
    return { status: 'invalid', diagnostics };
  }
  const diagnostics: ManifestDiagnostic[] = [];
  const ids = new Set<string>();
  const automations: AgentAutomation[] = [];
  for (const [index, job] of value.entries()) {
    const path = `/automations/${index}`;
    if (ids.has(job.id))
      diagnostics.push(automationDiagnostic('manifest-automation-duplicate-id', `${path}/id`));
    ids.add(job.id);
    const forms = ['run', 'prompt', 'payload'].filter((key) => Object.hasOwn(job, key));
    if (
      forms.length !== 1 ||
      (job.shell !== undefined && (job.prompt !== undefined || job.payload !== undefined))
    ) {
      diagnostics.push(automationDiagnostic('manifest-automation-payload', path));
      continue;
    }
    const payload =
      job.payload ??
      (job.run !== undefined
        ? { kind: 'command' as const, run: job.run, shell: job.shell }
        : { kind: 'prompt' as const, prompt: job.prompt! });
    if (payload.kind === 'command' && job.overrides !== undefined) {
      diagnostics.push(
        automationDiagnostic('manifest-automation-command-overrides', `${path}/overrides`),
      );
      continue;
    }
    if (payload.kind === 'command' && Object.hasOwn(job, 'thread')) {
      diagnostics.push(
        automationDiagnostic('manifest-automation-command-thread', `${path}/thread`),
      );
      continue;
    }
    const normalizedPayload =
      payload.kind === 'command'
        ? { kind: 'command' as const, run: normalizeCommand(payload.run, payload.shell ?? 'sh') }
        : {
            kind: 'prompt' as const,
            prompt: typeof payload.prompt === 'string' ? payload.prompt : { ...payload.prompt },
          };
    if (
      normalizedPayload.kind === 'command' &&
      normalizedPayload.run.kind === 'exec' &&
      unsafeCommandExecutable(normalizedPayload.run.executable)
    ) {
      diagnostics.push(
        automationDiagnostic(
          'manifest-automation-unsafe-path',
          `${path}/${job.payload ? 'payload/run' : 'run'}`,
        ),
      );
      continue;
    }
    let schedule: AutomationSchedule;
    try {
      schedule = normalizeAutomationSchedule(job.schedule);
    } catch {
      diagnostics.push(automationDiagnostic('manifest-automation-schedule', `${path}/schedule`));
      continue;
    }
    automations.push({
      id: job.id,
      enabled: job.enabled ?? true,
      runtimes: [...(job.runtimes ?? (['openclaw', 'codex'] as const))].sort(),
      schedule,
      payload: normalizedPayload,
      ...(job.thread == null
        ? {}
        : {
            thread:
              typeof job.thread === 'string'
                ? { name: job.thread.trim() }
                : Object.fromEntries(
                    Object.entries(job.thread).map(([key, value]) => [key, value.trim()]),
                  ),
          }),
      ...(job['timeout-seconds'] === undefined ? {} : { timeoutSeconds: job['timeout-seconds'] }),
      overrides: structuredClone(job.overrides ?? {}),
    });
  }
  const sharedNames = new Map<string, string>();
  for (const [index, job] of automations.entries()) {
    if (
      !job.runtimes.includes('openclaw') ||
      job.overrides.openclaw?.target !== undefined ||
      !job.thread?.id ||
      !job.thread.name
    )
      continue;
    const previous = sharedNames.get(job.thread.id);
    if (previous !== undefined && previous !== job.thread.name)
      diagnostics.push(
        automationDiagnostic(
          'manifest-automation-thread-name-conflict',
          `/automations/${index}/thread/name`,
        ),
      );
    sharedNames.set(job.thread.id, job.thread.name);
  }
  return diagnostics.length
    ? { status: 'invalid', diagnostics }
    : { status: 'valid', automations, diagnostics: [] };
}
