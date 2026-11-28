import AgentSystemToolError from '../../api/error.ts';
import { managedCommandTimeoutMs } from '../../api/cli-budget.ts';
import type { AgentSystemCliRunner } from '../../api/types.ts';
import type { DeclaredTools } from './config-schema.ts';
import resolveDeclaredExecutable from './executable.ts';

export interface DeclaredInvocation {
  id: string;
  argv: string[];
  stdin?: string;
}

// The runtime adapter supplies the verified binding and its native authorization,
// never a model-supplied workspace, executable, environment map, or policy.
export default async function runDeclaredTool(
  input: DeclaredInvocation,
  binding: {
    declarations: DeclaredTools;
    workspace: string;
    cwd: string;
    hostPath: string;
    hostExclusions: readonly string[];
    shimDirectories: readonly string[];
    authorize(id: string, argv: readonly string[]): Promise<void>;
    resolveValues(names: readonly string[]): Promise<Readonly<Record<string, string>>>;
    baseline: Readonly<Record<string, string>>;
    run: AgentSystemCliRunner;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
) {
  const declaration =
    Object.hasOwn(binding.declarations, input.id) && binding.declarations[input.id];
  if (!declaration)
    throw new AgentSystemToolError('tool_unavailable', 'The declared tool is unavailable.');
  if (input.argv.some((argument) => argument.includes('\0')))
    throw new AgentSystemToolError('invalid_arguments', 'Invalid tool argument.');
  await binding.authorize(input.id, input.argv);
  const executable = await resolveDeclaredExecutable(
    declaration.executable,
    binding.workspace,
    binding.hostPath,
    binding.hostExclusions,
    binding.shimDirectories,
  ).catch(() => {
    throw new AgentSystemToolError('tool_unavailable', 'The declared executable is unavailable.');
  });
  binding.signal?.throwIfAborted();
  const values = await binding.resolveValues(declaration.environment);
  const environment = { ...binding.baseline };
  const sensitive = new Set<string>();
  for (const name of declaration.environment) {
    if (!Object.hasOwn(values, name) || values[name] === undefined)
      throw new AgentSystemToolError(
        'credential_unavailable',
        `The declared variable ${name} is unavailable.`,
      );
    environment[name] = values[name];
    if (values[name]) sensitive.add(values[name]);
  }
  binding.signal?.throwIfAborted();
  const result = await binding.run({
    executable,
    argv: input.argv,
    cwd: binding.cwd,
    stdin: input.stdin,
    environment,
    signal: binding.signal,
    timeoutMs: binding.timeoutMs ?? managedCommandTimeoutMs,
  });
  const redact = (output: string) => {
    for (const value of sensitive) output = output.replaceAll(value, '[REDACTED]');
    return output;
  };
  return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) };
}
