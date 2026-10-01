import type { AgentSystemCapability } from '../../api/capability.ts';
import AgentSystemToolError from '../../api/error.ts';
import {
  excludedToolExecutableDirectories,
  unavailableToolExecutables,
} from '../../api/executable-requirements.ts';
import type { AgentSystemCliRunner } from '../../api/types.ts';
import type AgentEnvironmentService from '../../environment/service.ts';
import resolveManifestValue from '../../manifest/resolve-value.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContext,
} from '../../core/lifecycle-registry.ts';
import GoogleClient from './client.ts';
import { resolveGoogleConfiguration } from './config-schema.ts';
import { googleCredentials } from './credentials.ts';
import GoogleStore from './store.ts';
import createGoogleTool from './tool.ts';

export interface GoogleCapabilityDependencies {
  runCli: AgentSystemCliRunner;
  baseEnvironment: Readonly<NodeJS.ProcessEnv>;
  currentUid?: number;
  privateStateRoot?: string;
  excludedExecutableDirectories?: readonly string[];
  environmentService: Pick<AgentEnvironmentService, 'loadForWorkspace'>;
}

export default function createGoogleCapability(
  dependencies: GoogleCapabilityDependencies,
): AgentSystemCapability {
  const client = new GoogleClient(
    dependencies.runCli,
    dependencies.baseEnvironment,
    dependencies.excludedExecutableDirectories,
  );
  const store = new GoogleStore(
    dependencies.privateStateRoot,
    client,
    dependencies.currentUid,
    dependencies.baseEnvironment.GOG_HOME,
  );
  const load = async (context: AgentSystemLifecycleContext) => {
    const missing = await unavailableToolExecutables(
      ['gog'],
      dependencies.baseEnvironment.PATH ?? '',
      excludedToolExecutableDirectories(
        context.manifest,
        context.workspaceDir,
        dependencies.excludedExecutableDirectories,
      ),
    );
    if (missing.length)
      throw new AgentSystemToolError(
        'tool_unavailable',
        'Google requires gog on the host runtime PATH. Install GoG v0.43.0 or a compatible stable 0.x release.',
      );
    const result = await dependencies.environmentService.loadForWorkspace(
      context.workspaceDir,
      context.manifest.agent.id,
      'cli',
    );
    if (result.status !== 'loaded')
      throw new AgentSystemToolError(
        'credential_unavailable',
        'Google declared environment is unavailable.',
      );
    const configuration = resolveGoogleConfiguration(
      context.manifest.google!,
      {
        resolve(value, path) {
          const resolved = resolveManifestValue(value, result.environment.values, path);
          if (resolved.status === 'invalid')
            throw new AgentSystemToolError('credential_unavailable', resolved.diagnostic.message);
          return resolved.value;
        },
      },
      context.manifest.agent.email,
    );
    return {
      configuration,
      home: result.environment.values.GOG_HOME,
      excludedDirectories: excludedToolExecutableDirectories(
        context.manifest,
        context.workspaceDir,
        dependencies.excludedExecutableDirectories,
      ),
      material: googleCredentials(configuration, (name) => result.environment.values[name]),
    };
  };
  return {
    tools: [createGoogleTool(store)],
    lifecycleContributions: [
      {
        id: 'google',
        isConfigured: (manifest) => manifest.google !== undefined,
        validate: (context) => {
          if (
            context.manifest.google?.account === undefined &&
            context.manifest.agent.email === undefined
          )
            return {
              code: 'google-account-required',
              summary: 'Google requires an account declaration',
              diagnostics: [
                {
                  code: 'google-account-required',
                  fieldPath: '/google/account',
                  message: 'Google requires google.account or agent.email.',
                  severity: 'error' as const,
                },
              ],
            };
          return {
            code: 'google-config-valid',
            summary: 'Google account and OAuth credential bindings',
          };
        },
        async inspect(context) {
          try {
            const { configuration, material, excludedDirectories, home } = await load(context);
            const status = await store.inspect(
              context.manifest.agent.id,
              configuration.account,
              material,
              home,
            );
            if (status !== 'ready')
              return [
                {
                  code: 'google-setup-required',
                  message: 'Google private credentials are missing or differ from the manifest.',
                  status: 'drift' as const,
                  remediation: 'Run openclaw agent-system install.',
                },
              ];
            const lease = await store.acquire(
              context.manifest.agent.id,
              configuration.account,
              material,
              context.workspaceDir,
              excludedDirectories,
              undefined,
              home,
            );
            try {
              await client
                .withScope(excludedDirectories)
                .verify(lease.environment, context.workspaceDir, configuration.account);
            } finally {
              await lease.dispose();
            }
            return [
              {
                code: 'google-live-identity-ready',
                message:
                  'Live Google authentication matched ' +
                  configuration.account +
                  '; managed home: ' +
                  store.location(context.manifest.agent.id, home) +
                  '. Durable credentials were not changed.',
                status: 'healthy' as const,
              },
            ];
          } catch (error) {
            return [
              {
                code:
                  error instanceof AgentSystemToolError
                    ? 'google-' + error.code
                    : 'google-inspection-failed',
                message:
                  error instanceof AgentSystemToolError
                    ? error.message
                    : 'Google private state could not be inspected.',
                status: 'blocked' as const,
                remediation:
                  'Check GoG, declared credentials and provider permissions, then run install. Live authentication checks may contact Google.',
              },
            ];
          }
        },
        async reconcile(context) {
          try {
            const { configuration, material, excludedDirectories, home } = await load(context);
            const status = await store.reconcile(
              context.manifest.agent.id,
              configuration.account,
              material,
              context.workspaceDir,
              excludedDirectories,
              home,
            );
            return {
              outcomes: [
                {
                  code: 'google-credentials-' + status,
                  message: 'private Google OAuth credentials and verified account',
                  status,
                },
              ],
            };
          } catch (error) {
            throw new AgentSystemLifecycleError(
              'google',
              error instanceof AgentSystemToolError
                ? 'google-' + error.code
                : 'google-install-failed',
              error instanceof AgentSystemToolError
                ? error.message
                : 'Google installation failed; private state was not activated.',
            );
          }
        },
      },
    ],
  };
}
