import { delimiter } from 'node:path';

import BoundCommandService, {
  type BoundCommandServiceDependencies,
} from './bound-command-service.ts';
import createSetupCommandRunner, {
  SetupCommandError,
  type SetupCommandResult,
} from './setup-runner.ts';
import type { AgentSetupCommand } from '../manifest/setup-schema.ts';
import type { AgentManifest } from '../manifest/types.ts';

export type SetupCommandServiceDependencies = BoundCommandServiceDependencies;

/** keep setup prerequisites and check/apply semantics separate from bound execution. */
export default class SetupCommandService extends BoundCommandService {
  async runPreAgent(
    command: AgentSetupCommand,
    target: { agentId: string; workspaceDir: string; mode?: 'check' | 'apply' },
    signal?: AbortSignal,
  ): Promise<SetupCommandResult> {
    const dependencies = this.dependencies;
    return createSetupCommandRunner({
      baseEnvironment: dependencies.baseEnvironment,
      inheritOpenClawEnvironment: false,
      runCommandWithTimeout: dependencies.runCommandWithTimeout,
      ...(dependencies.temporaryDirectory === undefined
        ? {}
        : { temporaryDirectory: dependencies.temporaryDirectory }),
    })(
      command,
      {
        workspaceDir: target.workspaceDir,
        executableDirectories: (dependencies.baseEnvironment.PATH ?? '').split(delimiter),
      },
      signal,
    );
  }

  async prepare(context: {
    manifest: AgentManifest;
    workspaceDir: string;
    signal?: AbortSignal;
  }): Promise<void> {
    const controller = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([context.signal, controller.signal])
      : controller.signal;
    const probes = [
      ...(context.manifest.git ? [{ command: 'git', argv: ['--version'] }] : []),
      ...(context.manifest.github
        ? [{ command: 'gh', argv: ['api', 'user', '--jq', '.login'] }]
        : []),
    ];
    try {
      for (const probe of probes) {
        signal.throwIfAborted();
        const result = await this.dependencies.toolRegistry.invoke(
          probe.command,
          this.dependencies.toolRuntime,
          probe.argv,
          {
            source: 'command',
            agentId: context.manifest.agent.id,
            workspaceDir: context.workspaceDir,
            configurationMode: 'inspect',
          },
          undefined,
          signal,
        );
        if (
          result.kind !== 'cli' ||
          result.commandResult.exitCode !== 0 ||
          result.commandResult.timedOut
        ) {
          throw new Error('unavailable prerequisite');
        }
      }
    } catch {
      throw new SetupCommandError('setup-prerequisite-blocked');
    } finally {
      controller.abort();
    }
  }

  override run(
    command: AgentSetupCommand,
    target: { agentId: string; workspaceDir: string; mode?: 'check' | 'apply' },
    signal?: AbortSignal,
  ): Promise<SetupCommandResult> {
    return super.run(command, { ...target, mode: target.mode ?? 'check' }, signal);
  }
}
