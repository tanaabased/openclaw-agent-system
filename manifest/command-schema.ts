import { Type, type Static } from 'typebox';

export const commandShellSchema = Type.Union([
  Type.Literal('sh'),
  Type.Literal('bash'),
  Type.Literal('zsh'),
]);
export const commandScriptSchema = Type.String({
  pattern: '^(?=[\\s\\S]*\\S)[^\\u0000]*(?![\\s\\S])',
});
export const commandExecutableSchema = Type.String({
  pattern: '^(?=[\\s\\S]*\\S)[^\\u0000\\r\\n]*(?![\\s\\S])',
});
export const commandArgumentSchema = Type.String({ pattern: '^[^\\u0000]*(?![\\s\\S])' });
export const commandArgvSchema = Type.Intersect([
  Type.Tuple([commandExecutableSchema], { additionalItems: true }),
  Type.Array(commandArgumentSchema),
]);
export const commandObjectSchema = Type.Object(
  {
    command: commandExecutableSchema,
    args: Type.Optional(Type.Array(commandArgumentSchema)),
  },
  { additionalProperties: false },
);
export const commandSchema = Type.Union([
  commandScriptSchema,
  commandArgvSchema,
  commandObjectSchema,
]);
export type CommandShell = Static<typeof commandShellSchema>;
export type CommandInput = Static<typeof commandSchema>;
export type NormalizedCommand =
  | { kind: 'shell'; script: string; shell: CommandShell }
  | { kind: 'exec'; executable: string; args: string[] };

export function unsafeCommandExecutable(executable: string): boolean {
  return executable === '.' || executable.includes('\\') || executable.split('/').includes('..');
}

/** preserve script bytes and argument order; callers own timeout and execution policy. */
export function normalizeCommand(command: CommandInput, shell: CommandShell): NormalizedCommand {
  if (typeof command === 'string') return { kind: 'shell', script: command, shell };
  if (Array.isArray(command))
    return { kind: 'exec', executable: command[0], args: command.slice(1) };
  return { kind: 'exec', executable: command.command, args: [...(command.args ?? [])] };
}
