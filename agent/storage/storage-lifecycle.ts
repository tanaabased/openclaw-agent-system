import { join } from 'node:path';
import type { AgentSystemLifecycleContext } from '../../core/lifecycle-registry.ts';

/** The runtime selects the private roots and agent file; both use the packaged migration chains. */
export default function storageLifecycle(options: {
  agentRoot(): string;
  agentName(context: AgentSystemLifecycleContext): string;
  installationRoot: string;
  schemaRoot: string;
}) {
  return (['agent-storage', 'installation-storage'] as const).map((component) => {
    const agent = component === 'agent-storage';
    const migrations = join(options.schemaRoot, agent ? 'migrations' : 'installation-migrations');
    const database = async (context: AgentSystemLifecycleContext) => {
      const { AgentDatabase } = await import('./agent-database.ts');
      return agent
        ? new AgentDatabase(options.agentRoot(), options.agentName(context), component)
        : new AgentDatabase(options.installationRoot, 'installation', component);
    };
    return {
      id: component,
      isConfigured: () => true,
      async inspect(context: AgentSystemLifecycleContext) {
        const store = await database(context);
        return [await store.inspect(migrations)];
      },
      async reconcile(context: AgentSystemLifecycleContext) {
        const store = await database(context);
        return { outcomes: [await store.install(migrations)] };
      },
    };
  });
}
