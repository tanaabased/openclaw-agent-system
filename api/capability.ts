import type { AgentSystemLifecycleContribution } from '../core/lifecycle-registry.ts';
import type { RegisteredAgentSystemTool } from './types.ts';

/** Group one first-party capability's lifecycle and tool registrations. */
export interface AgentSystemCapability {
  lifecycleContributions: readonly AgentSystemLifecycleContribution[];
  tools: readonly RegisteredAgentSystemTool[];
}
