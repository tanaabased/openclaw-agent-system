import { resolve } from 'node:path';

import defineAgentSystemCliTool from '../../api/define-cli-tool.ts';
import resolveToolWorkingDirectory from '../../api/resolve-working-directory.ts';
import { assertGoogleIdentity, googleIdentityArgv, googleFailureStatus } from './client.ts';
import { classifyGoogleCommand, parseGoogleCommand, validateGoogleFiles } from './command.ts';
import { resolveGoogleConfiguration } from './config-schema.ts';
import { googleCredentials } from './credentials.ts';
import type GoogleStore from './store.ts';
import { googleToolSchema } from './tool-schema.ts';

export default function createGoogleTool(store: GoogleStore) {
  return defineAgentSystemCliTool({
    apiVersion: 1,
    id: 'google',
    authorization: {
      authorize: () => ({ status: 'allowed' as const }),
      policyId: 'agent-system.google',
    },
    configuration: {
      read: (manifest) =>
        manifest.google
          ? {
              ...manifest.google,
              agentEmail: manifest.agent.email,
              pathPrepend: manifest.environment?.pathPrepend ?? [],
            }
          : undefined,
      resolve: (configuration, resolver) => ({
        ...resolveGoogleConfiguration(configuration, resolver, configuration.agentEmail),
        pathPrepend: configuration.pathPrepend,
      }),
    },
    commands: [{ command: 'gog', environmentVariable: 'gog', hostFallback: 'gog' }],
    guidance: {
      prompt:
        'For Google work in OpenClaw, use $agent-system-google-cli and agent_system_google with canonical noninteractive gog data commands. Agent System supplies the active agent account and OAuth client; never override authentication or bypass managed failures. Outside OpenClaw, keep standalone Codex native.',
    },
    runner: {
      executable: 'gog',
      maxOutputBytes: 65536,
      timeoutMs: 30000,
      credentialRejected: (result) => result.exitCode === 4,
      argv(input, configuration) {
        return [
          '--account=' + configuration.account,
          '--client=agent-system',
          '--no-input',
          ...(!input.argv.some((arg) => arg === '--plain' || arg.startsWith('--plain='))
            ? ['--json']
            : []),
          ...parseGoogleCommand(input).argv,
        ];
      },
      async acquireResources(_input, configuration, scope) {
        const home = scope.resolveEnvironment('GOG_HOME');
        await store.assertLocation(scope.agentId, home, [
          scope.workspaceDir,
          ...(scope.admittedWorkingDirectories ?? []),
        ]);
        return store.acquire(
          scope.agentId,
          configuration.account,
          googleCredentials(configuration, scope.resolveEnvironment),
          scope.workspaceDir,
          configuration.pathPrepend.map((path) => resolve(scope.workspaceDir, path)),
          scope.signal,
          home,
        );
      },
      preflight(configuration) {
        return {
          argv: [
            '--account=' + configuration.account,
            '--client=agent-system',
            '--no-input',
            '--json',
            ...googleIdentityArgv,
          ],
          validate: (result) => assertGoogleIdentity(result, configuration.account),
        };
      },
      async workingDirectory(input, _configuration, scope) {
        const cwd = await resolveToolWorkingDirectory(
          scope.workspaceDir,
          scope.commandWorkingDirectory ?? '.',
          scope.admittedWorkingDirectories,
        );
        await validateGoogleFiles(input, cwd, [
          scope.workspaceDir,
          ...(scope.admittedWorkingDirectories ?? []),
        ]);
        return cwd;
      },
      stdin: (input) => input.stdin,
    },
    tool: {
      name: 'agent_system_google',
      label: 'Agent System Google CLI',
      description:
        'Run reviewed noninteractive GoG v0.42.0 Google data commands with the active agent account, isolated OAuth store and bounded IO. Use canonical service/subcommand arguments. Auth/config overrides and unreviewed commands/flags are unavailable. File inputs and explicit download paths must stay inside the workspace.',
      parameters: googleToolSchema,
      classify: classifyGoogleCommand,
      validate: (input) => {
        parseGoogleCommand(input);
      },
      inputFromCommand: (argv, stdin) => ({
        argv: [...argv],
        ...(stdin === undefined ? {} : { stdin }),
      }),
      normalize: (result) => ({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
        status: googleFailureStatus(result),
      }),
    },
  });
}
