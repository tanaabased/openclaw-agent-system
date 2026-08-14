import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import type AgentCommandAuthority from './agent-command-authority.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import type { Logger } from './logger.ts';

type RegistrationApi = Pick<OpenClawPluginApi, 'on' | 'registerService'>;
type AuthorityManifestService = Pick<AgentManifestService, 'loadForRuntimeContext'>;

export interface RegisterAgentCommandAuthorityDependencies {
  authority: Pick<AgentCommandAuthority, 'issue' | 'start' | 'stop'>;
  logger: Logger;
  manifestService: AuthorityManifestService;
}

/** Issue opaque active-agent capabilities only to Gateway-hosted exec descendants. */
export default function registerAgentCommandAuthority(
  api: RegistrationApi,
  dependencies: RegisterAgentCommandAuthorityDependencies,
): void {
  api.registerService({
    id: 'agent-system-command-authority',
    async start() {
      try {
        await dependencies.authority.start();
      } catch {
        dependencies.logger.error('security: agent_command_authority_start_failed');
      }
    },
    async stop() {
      await dependencies.authority.stop();
    },
  });
  api.on('resolve_exec_env', async (event, context) => {
    if (event.host !== 'gateway') return;
    const loaded = await dependencies.manifestService.loadForRuntimeContext(
      context,
      'resolve_exec_env',
    );
    if (loaded.status !== 'loaded') return;
    return dependencies.authority.issue(loaded.manifest.agent.id);
  });
}
