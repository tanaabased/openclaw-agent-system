import { realpath } from 'node:fs/promises';

import { AutomationError } from '../agent/automation-gateway.ts';
import type AutomationService from '../agent/automation-service.ts';
import type BoundCommandService from '../agent/bound-command-service.ts';
import type AgentManifestService from '../manifest/service.ts';
import type { CliOutput } from './output.ts';

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
    const result = await options.commands.run(
      command,
      { agentId: context.agentId, workspaceDir: context.workspaceDir },
      signal,
    );
    const success = result.exitCode === 0 && !result.timedOut && !signal.aborted;
    options.output.writeStdout(
      `${JSON.stringify({ id: options.id, status: success ? 'ok' : 'error', code: result.timedOut ? 'automation-timeout' : signal.aborted ? 'automation-cancelled' : 'automation-command-completed', exitCode: result.exitCode })}\n`,
    );
    return success ? 0 : 1;
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
