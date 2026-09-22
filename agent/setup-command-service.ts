import { realpath } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

import AgentCommandAuthority, {
  agentCommandAuthorityEnvironmentName,
  agentCommandCapabilityEnvironmentName,
} from './command-authority.ts';
import createSetupCommandRunner, {
  SetupCommandError,
  type SetupCommandResult,
} from './setup-runner.ts';
import AgentSystemToolError from '../api/error.ts';
import type AgentSystemToolRegistry from '../api/registry.ts';
import type AgentSystemToolRuntime from '../api/runtime.ts';
import type { AgentSetupCommand } from '../manifest/setup-schema.ts';
import type AgentManifestService from '../manifest/service.ts';

export interface SetupCommandServiceDependencies {
  authorityRoot?: string;
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  currentUid?: number;
  manifestService: Pick<AgentManifestService, 'loadForAgentId'>;
  packageDir: string;
  runCommandWithTimeout: Parameters<typeof createSetupCommandRunner>[0]['runCommandWithTimeout'];
  temporaryDirectory?: string;
  toolRegistry: Pick<AgentSystemToolRegistry, 'invoke'>;
  toolRuntime: AgentSystemToolRuntime;
}

/** Own one setup command's authority and keep credential-bearing tool execution in its operator process. */
export default class SetupCommandService {
  constructor(private readonly dependencies: SetupCommandServiceDependencies) {}

  async run(
    command: AgentSetupCommand,
    target: { agentId: string; workspaceDir: string },
    signal?: AbortSignal,
  ): Promise<SetupCommandResult> {
    const dependencies = this.dependencies;
    const authority = new AgentCommandAuthority({
      manifestService: dependencies.manifestService,
      currentUid: dependencies.currentUid ?? process.getuid?.(),
      ...(dependencies.authorityRoot === undefined ? {} : { rootDir: dependencies.authorityRoot }),
      leaseLifetimeMs: command.timeoutSeconds * 1_000,
      async executeCommand(input, binding, commandSignal) {
        try {
          commandSignal.throwIfAborted();
          const result = await dependencies.toolRegistry.invoke(
            input.command,
            dependencies.toolRuntime,
            input.argv,
            {
              source: 'agent-command',
              agentId: binding.agentId,
              workspaceDir: binding.workingDirectory,
              admittedWorkingDirectories: binding.admittedWorkingDirectories,
            },
            input.stdin,
            commandSignal,
          );
          if (result.kind === 'cli') {
            const { exitCode, stdout, stderr } = result.commandResult;
            return { exitCode, stdout, stderr };
          }
          const serialized = JSON.stringify(result.output, undefined, 2);
          return {
            exitCode: 0,
            stdout: serialized === undefined ? '' : `${serialized}\n`,
            stderr: '',
          };
        } catch (error) {
          const code = error instanceof AgentSystemToolError ? error.code : 'execution_failed';
          return {
            exitCode: 1,
            stdout: '',
            stderr: `Agent System tool command failed (${code}).\n`,
          };
        }
      },
    });
    try {
      signal?.throwIfAborted();
      const loaded = await dependencies.manifestService.loadForAgentId(target.agentId, 'service');
      if (
        loaded.status !== 'loaded' ||
        loaded.manifest.agent.id !== target.agentId ||
        (await realpath(loaded.scope.workspaceDir)) !== (await realpath(target.workspaceDir))
      ) {
        throw new SetupCommandError('setup-agent-not-resolved');
      }
      await authority.start();
      const environment = authority.issue(target.agentId);
      const binding = await authority.resolve(environment, target.workspaceDir);
      if (!binding?.executeCommand || binding.agentId !== target.agentId) {
        throw new SetupCommandError('setup-agent-not-resolved');
      }
      return await createSetupCommandRunner(dependencies)(
        command,
        {
          workspaceDir: target.workspaceDir,
          executableDirectories: (dependencies.baseEnvironment.PATH ?? '').split(delimiter),
          commandBinding: {
            launcherDirectory: join(dependencies.packageDir, 'bin'),
            authority: environment[agentCommandAuthorityEnvironmentName]!,
            capability: environment[agentCommandCapabilityEnvironmentName]!,
          },
        },
        signal,
      );
    } catch (error) {
      if (error instanceof SetupCommandError) throw error;
      throw new SetupCommandError('setup-command-context-failed');
    } finally {
      await authority.stop();
    }
  }
}
