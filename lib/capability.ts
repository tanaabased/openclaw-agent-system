import type { AgentSystemLifecycleContribution } from './lifecycle-registry.ts';
import type { RegisteredAgentSystemTool } from './tool-types.ts';

/** Group one first-party capability's lifecycle and tool registrations. */
export interface AgentSystemCapability {
  lifecycleContributions: readonly AgentSystemLifecycleContribution[];
  tools: readonly RegisteredAgentSystemTool[];
}
