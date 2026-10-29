import { realpath } from 'node:fs/promises';

import { AutomationError } from '../agent/automation-gateway.ts';
import type AutomationService from '../agent/automation-service.ts';
import type BoundCommandService from '../agent/bound-command-service.ts';
import type AgentManifestService from '../manifest/service.ts';
import type { CliOutput } from './output.ts';

// reserve space for both streams and completion metadata inside native capture's 16 kib limit.
const maximumStreamBytes = 7_168;

function capturedStream(text: string, name: string, truncatedBytes = 0) {
  const bytes = Buffer.from(text);
  const truncated = truncatedBytes > 0 || bytes.length > maximumStreamBytes;
  const content = new TextDecoder().decode(bytes.subarray(0, maximumStreamBytes), { stream: true });
  return {
    text: `${content}${content && !content.endsWith('\n') ? '\n' : ''}${truncated ? `[${name} truncated]\n` : ''}`,
    truncated,
  };
}

/** fixed scheduler entry; operator admission must precede this runner. */
export default async function executeAutomation(options: {
  id: string;
  hash: string;
  workspaceDir: string;
  manifestService: Pick<AgentManifestService, 'loadForCommandDirectory' | 'loadForAgentId'>;
  automations: AutomationService;
  commands: BoundCommandService;
  output: CliOutput;
  signal?: AbortSignal;
}): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGTERM', cancel);
  process.once('SIGINT', cancel);
  try {
    const manifest = await options.manifestService.loadForCommandDirectory(
      options.workspaceDir,
      'cli',
    );
    if (manifest.status !== 'loaded') throw new AutomationError('automation-manifest-unavailable');
    const installed = await options.manifestService.loadForAgentId(
      manifest.manifest.agent.id,
      'service',
    );
    if (
      installed.status !== 'loaded' ||
      installed.manifest.agent.id !== manifest.manifest.agent.id ||
      (await realpath(installed.scope.workspaceDir)) !== (await realpath(options.workspaceDir))
    )
      throw new AutomationError('automation-agent-not-installed');
    const { command, context } = await options.automations.admit(
      installed.manifest,
      installed.scope.workspaceDir,
      options.id,
      options.hash,
    );
    const signal = AbortSignal.any([
      controller.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(command.timeoutSeconds * 1000),
    ]);
    signal.throwIfAborted();
    let active = true;
    const snapshot = structuredClone(installed);
    const assertActive = () => {
      signal.throwIfAborted();
      if (!active) throw new AutomationError('automation-execution-stale');
    };
    const assertCurrent = async () => {
      assertActive();
      const current = await options.manifestService.loadForAgentId(context.agentId, 'service');
      if (
        current.status !== 'loaded' ||
        current.digest !== snapshot.digest ||
        current.path !== snapshot.path ||
        (await realpath(current.scope.workspaceDir)) !==
          (await realpath(snapshot.scope.workspaceDir))
      )
        throw new AutomationError('automation-execution-stale');
      await options.automations.admit(
        current.manifest,
        current.scope.workspaceDir,
        options.id,
        options.hash,
      );
      assertActive();
    };
    let result;
    try {
      result = await options.commands.run(
        command,
        {
          agentId: context.agentId,
          workspaceDir: context.workspaceDir,
          captureOutput: true,
          automation: { loaded: snapshot, assertActive, assertCurrent },
        },
        signal,
      );
    } finally {
      active = false;
    }
    const exited =
      !result.timedOut &&
      !signal.aborted &&
      !result.signal &&
      (!result.termination || result.termination === 'exit');
    const success = exited && result.exitCode === 0;
    const stdout = capturedStream(
      result.output?.stdout ?? '',
      'stdout',
      result.output?.stdoutTruncatedBytes,
    );
    const stderr = capturedStream(
      result.output?.stderr ?? '',
      'stderr',
      result.output?.stderrTruncatedBytes,
    );
    if (stdout.text) options.output.writeStdout(stdout.text);
    if (stderr.text) options.output.writeStderr(stderr.text);
    options.output.writeStdout(
      `${JSON.stringify({ id: options.id, status: success ? 'ok' : 'error', code: result.timedOut ? 'automation-timeout' : signal.aborted ? 'automation-cancelled' : result.signal || result.termination === 'signal' ? 'automation-command-signalled' : 'automation-command-completed', exitCode: result.exitCode, termination: result.termination, signal: result.signal, truncated: result.truncated || stdout.truncated || stderr.truncated })}\n`,
    );
    return exited &&
      typeof result.exitCode === 'number' &&
      Number.isInteger(result.exitCode) &&
      result.exitCode >= 0 &&
      result.exitCode <= 255
      ? result.exitCode
      : 1;
  } catch (error) {
    options.output.writeStdout(
      `${JSON.stringify({ id: options.id, status: 'error', code: controller.signal.aborted ? 'automation-cancelled' : error instanceof AutomationError ? error.code : 'automation-command-failed' })}\n`,
    );
    return 1;
  } finally {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  }
}
