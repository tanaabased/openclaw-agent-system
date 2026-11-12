import literalArguments from './literal-command-arguments.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { inspectCodexWorkspaceBinding } from './identity/codex-workspace-binding.ts';
import { nativeObject } from './automations/automation-gateway.ts';
import { resolveToolExecutable } from '../api/cli-runner.ts';

/** native hook trust delegates execution to this installed runtime, not to a second operation policy. */
async function permissionDecision(
  runtime: { nodeExecutable: string; pluginRoot: string; pluginData: string },
  event: unknown,
): Promise<unknown> {
  try {
    if (
      !nativeObject(event) ||
      event.hook_event_name !== 'PermissionRequest' ||
      event.tool_name !== 'Bash' ||
      !nativeObject(event.tool_input) ||
      typeof event.tool_input.command !== 'string' ||
      event.tool_input.command.length > 128_000 ||
      Object.keys(event.tool_input).some((key) => !['command', 'description'].includes(key))
    )
      return {};
    const args = literalArguments(event.tool_input.command);
    if (
      !args ||
      args.length < 3 ||
      (args[0] !== 'node' && !isAbsolute(args[0]!)) ||
      !isAbsolute(args[1]!)
    )
      return {};
    const expected = join(runtime.pluginRoot, 'dist/codex/codex-runtime.js');
    const executable =
      args[0] === 'node'
        ? await resolveToolExecutable('node', process.env.PATH ?? '')
        : await realpath(args[0]!);
    if (
      executable !== (await realpath(runtime.nodeExecutable)) ||
      (await realpath(args[1]!)) !== (await realpath(expected))
    )
      return {};
    // keep installation data scoped when supplied; command and stdin semantics belong to the runtime.
    for (let index = 2; index < args.length; index++) {
      const argument = args[index]!;
      if (argument === '--plugin-data') {
        if (args[++index] !== runtime.pluginData) return {};
      } else if (argument.startsWith('--plugin-data=')) return {};
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
  } catch {
    // unavailable paths or unknown inputs abstain; the hook never denies or changes workflow state.
    return {};
  }
}

/** diagnostics are best effort and never change the native approval result. */
export default async function codexPermission(
  runtime: { nodeExecutable: string; pluginRoot: string; pluginData: string },
  input: unknown,
): Promise<unknown> {
  const started = Date.now();
  const invocationId = randomUUID();
  let event = input;
  if (typeof input === 'string') {
    try {
      event = JSON.parse(input);
    } catch {
      event = undefined;
    }
  }
  const binding = await inspectCodexWorkspaceBinding(runtime.pluginData).catch(() => undefined);
  const debug =
    binding?.status === 'bound' &&
    binding.preview.status === 'ready' &&
    binding.preview.manifest.status === 'loaded' &&
    binding.preview.manifest.manifest.debug === true;
  if (!debug) return permissionDecision(runtime, event);
  const sessionId =
    nativeObject(event) &&
    typeof event.session_id === 'string' &&
    /^[a-f0-9-]{36}$/iu.test(event.session_id)
      ? event.session_id
      : undefined;
  const command =
    nativeObject(event) && nativeObject(event.tool_input) ? event.tool_input.command : undefined;
  const commandSha256 =
    typeof command === 'string' ? createHash('sha256').update(command).digest('hex') : undefined;
  const record = async (phase: 'started' | 'decision', decision?: 'allow' | 'abstain') => {
    try {
      await mkdir(runtime.pluginData, { recursive: true, mode: 0o700 });
      const file = await open(join(runtime.pluginData, 'permission-request.jsonl'), 'a', 0o600);
      try {
        if (phase === 'started' && (await file.stat()).size >= 1024 * 1024) await file.truncate(0);
        await file.appendFile(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            invocationId,
            sessionId,
            commandSha256,
            phase,
            decision,
            elapsedMs: Date.now() - started,
          }) + '\n',
        );
      } finally {
        await file.close();
      }
    } catch {
      // unavailable diagnostics must not become an approval blocker.
    }
  };
  await record('started');
  const result = await permissionDecision(runtime, event);
  await record(
    'decision',
    nativeObject(result) && 'hookSpecificOutput' in result ? 'allow' : 'abstain',
  );
  return result;
}
