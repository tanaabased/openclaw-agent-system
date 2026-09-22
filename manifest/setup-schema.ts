import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { ManifestDiagnostic } from './types.ts';

export const setupDefaultTimeoutSeconds = 300;
export const setupMaximumTimeoutSeconds = 3_600;

const shellSchema = Type.Union([Type.Literal('sh'), Type.Literal('bash'), Type.Literal('zsh')]);
const scriptSchema = Type.String({ pattern: '^(?=[\\s\\S]*\\S)[^\\u0000]*(?![\\s\\S])' });
const executableSchema = Type.String({
  pattern: '^(?=[\\s\\S]*\\S)[^\\u0000\\r\\n]*(?![\\s\\S])',
});
const argumentSchema = Type.String({ pattern: '^[^\\u0000]*(?![\\s\\S])' });
const argvSchema = Type.Intersect([
  Type.Tuple([executableSchema], { additionalItems: true }),
  Type.Array(argumentSchema),
]);
const commandObjectSchema = Type.Object(
  {
    command: executableSchema,
    args: Type.Optional(Type.Array(argumentSchema)),
    'timeout-seconds': Type.Optional(
      Type.Integer({ minimum: 1, maximum: setupMaximumTimeoutSeconds }),
    ),
  },
  { additionalProperties: false },
);
const commandSchema = Type.Union([scriptSchema, argvSchema, commandObjectSchema]);
const stepProperties = {
  shell: Type.Optional(shellSchema),
  check: Type.Optional(commandSchema),
  apply: commandSchema,
};
const shortSchema = Type.Object(stepProperties, { additionalProperties: false });
const stepsSchema = Type.Object(
  {
    shell: Type.Optional(shellSchema),
    steps: Type.Array(
      Type.Object(
        {
          id: Type.String({ pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*(?![\\s\\S])' }),
          ...stepProperties,
        },
        { additionalProperties: false },
      ),
      { minItems: 1 },
    ),
  },
  { additionalProperties: false },
);

export const externalAgentSetupSchema = Type.Union([scriptSchema, shortSchema, stepsSchema]);

export type AgentSetupShell = Static<typeof shellSchema>;
export type AgentSetupCommand =
  | { kind: 'shell'; script: string; shell: AgentSetupShell; timeoutSeconds: number }
  | { kind: 'exec'; executable: string; args: string[]; timeoutSeconds: number };

export interface AgentSetupStep {
  id: string;
  apply: AgentSetupCommand;
  check?: AgentSetupCommand;
}

export interface AgentSetupConfiguration {
  steps: AgentSetupStep[];
}

export type NormalizedAgentSetup =
  | { status: 'valid'; setup: AgentSetupConfiguration; diagnostics: [] }
  | { status: 'invalid'; diagnostics: ManifestDiagnostic[] };

type ExternalCommand = Static<typeof commandSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diagnostic(code: string, fieldPath: string): ManifestDiagnostic {
  return {
    code,
    fieldPath,
    message: `Invalid setup declaration at ${fieldPath}.`,
    severity: 'error',
  };
}

function pointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function schemaDiagnostics(schema: TSchema, value: unknown, prefix: string): ManifestDiagnostic[] {
  return Value.Errors(schema, value)
    .filter((error) => !error.schemaPath.includes('/anyOf/'))
    .flatMap((error) => {
      const path = `${prefix}${error.instancePath}`;
      if (error.keyword === 'additionalProperties') {
        return error.params.additionalProperties.map((key) =>
          diagnostic('manifest-unknown-key', `${path}/${pointerSegment(key)}`),
        );
      }
      if (error.keyword === 'required') {
        return error.params.requiredProperties.map((key) =>
          diagnostic('manifest-required-key', `${path}/${pointerSegment(key)}`),
        );
      }
      // Expand only command unions, so errors retain the selected syntax's field paths.
      if (error.keyword === 'anyOf' && /\/(apply|check)$/u.test(error.instancePath)) {
        const command = error.instancePath
          .slice(1)
          .split('/')
          .reduce<unknown>(
            (current, key) =>
              isRecord(current) || Array.isArray(current)
                ? (current as Record<string, unknown>)[key]
                : undefined,
            value,
          );
        const selected =
          typeof command === 'string'
            ? scriptSchema
            : Array.isArray(command)
              ? argvSchema
              : commandObjectSchema;
        return schemaDiagnostics(selected, command, path);
      }
      return [diagnostic('manifest-schema', path)];
    });
}

function decodeCommand(command: ExternalCommand, shell: AgentSetupShell): AgentSetupCommand {
  if (typeof command === 'string') {
    return { kind: 'shell', script: command, shell, timeoutSeconds: setupDefaultTimeoutSeconds };
  }
  if (Array.isArray(command)) {
    return {
      kind: 'exec',
      executable: command[0],
      args: command.slice(1),
      timeoutSeconds: setupDefaultTimeoutSeconds,
    };
  }
  return {
    kind: 'exec',
    executable: command.command,
    args: [...(command.args ?? [])],
    timeoutSeconds: command['timeout-seconds'] ?? setupDefaultTimeoutSeconds,
  };
}

/** Normalize a setup value without reading files, resolving environment values, or executing code. */
export function normalizeAgentSetup(value: unknown): NormalizedAgentSetup {
  if (
    isRecord(value) &&
    Object.hasOwn(value, 'steps') &&
    (Object.hasOwn(value, 'check') || Object.hasOwn(value, 'apply'))
  ) {
    return { status: 'invalid', diagnostics: [diagnostic('manifest-setup-mixed-forms', '/setup')] };
  }
  const selected =
    typeof value === 'string'
      ? scriptSchema
      : isRecord(value) && Object.hasOwn(value, 'steps')
        ? stepsSchema
        : shortSchema;
  if (!Value.Check(externalAgentSetupSchema, value)) {
    return { status: 'invalid', diagnostics: schemaDiagnostics(selected, value, '/setup') };
  }

  const setup = typeof value === 'string' ? { apply: value } : value;
  const shell = setup.shell ?? 'sh';
  const entries = 'steps' in setup ? setup.steps : [{ id: 'default', ...setup }];
  const ids = new Set<string>();
  const diagnostics: ManifestDiagnostic[] = [];
  const steps = entries.map((entry, index) => {
    const path = 'steps' in setup ? `/setup/steps/${index}` : '/setup';
    if (ids.has(entry.id))
      diagnostics.push(diagnostic('manifest-setup-duplicate-id', `${path}/id`));
    ids.add(entry.id);
    for (const key of ['check', 'apply'] as const) {
      const command = entry[key];
      if (command === undefined || typeof command === 'string') continue;
      const executable = Array.isArray(command) ? command[0] : command.command;
      if (executable === '.' || executable.includes('\\') || executable.split('/').includes('..')) {
        diagnostics.push(
          diagnostic(
            'manifest-setup-unsafe-path',
            `${path}/${key}/${Array.isArray(command) ? '0' : 'command'}`,
          ),
        );
      }
    }
    return {
      id: entry.id,
      apply: decodeCommand(entry.apply, entry.shell ?? shell),
      ...(entry.check === undefined
        ? {}
        : { check: decodeCommand(entry.check, entry.shell ?? shell) }),
    };
  });
  return diagnostics.length > 0
    ? { status: 'invalid', diagnostics }
    : { status: 'valid', setup: { steps }, diagnostics: [] };
}
