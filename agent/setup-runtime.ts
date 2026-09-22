import type { AgentSetupRuntime, AgentSetupStep } from '../manifest/setup-schema.ts';

/** Omitted runtime filters apply to every supported integration. */
export default function setupStepApplies(
  step: AgentSetupStep,
  runtime: AgentSetupRuntime,
): boolean {
  return step.runtimes === undefined || step.runtimes.includes(runtime);
}
