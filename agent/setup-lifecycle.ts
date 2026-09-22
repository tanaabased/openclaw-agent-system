import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContext,
  type AgentSystemLifecycleFinding,
  type AgentSystemLifecycleReconcileResult,
} from '../core/lifecycle-registry.ts';
import type SetupCommandService from './setup-command-service.ts';
import type { AgentSetupCommand, AgentSetupStep } from '../manifest/setup-schema.ts';

/** Inspect every declared check; reconcile ordered steps without rolling back external effects. */
export default class SetupLifecycleService {
  constructor(private readonly commands: Pick<SetupCommandService, 'run'>) {}

  async inspect(context: AgentSystemLifecycleContext): Promise<AgentSystemLifecycleFinding[]> {
    const findings: AgentSystemLifecycleFinding[] = [];
    for (const step of context.setup?.steps ?? []) {
      const status = step.check ? await this.check(step.check, context) : 'manual';
      findings.push({
        component: 'setup',
        stepId: step.id,
        code: `setup-${status}`,
        status,
        message: `Setup step ${step.id} is ${status}.`,
        ...(status === 'healthy'
          ? {}
          : {
              remediation:
                status === 'blocked'
                  ? 'Check setup prerequisites and the declared check, then run install.'
                  : 'Run install to apply this setup step.',
            }),
      });
    }
    return findings;
  }

  async reconcile(
    context: AgentSystemLifecycleContext,
  ): Promise<AgentSystemLifecycleReconcileResult> {
    const outcomes: AgentSystemLifecycleReconcileResult['outcomes'] = [];
    for (const step of context.setup?.steps ?? []) {
      const before = step.check ? await this.check(step.check, context) : 'manual';
      if (before === 'blocked') this.fail(step, 'setup-check-blocked');
      if (before !== 'healthy') {
        const applied = await this.execute(step.apply, context, 'apply');
        if (applied !== 0) this.fail(step, 'setup-apply-failed');
        if (step.check) {
          const after = await this.check(step.check, context);
          if (after === 'blocked') this.fail(step, 'setup-check-blocked');
          if (after !== 'healthy') this.fail(step, 'setup-not-converged');
        }
      }
      outcomes.push({
        component: 'setup',
        stepId: step.id,
        code: before === 'healthy' ? 'setup-unchanged' : 'setup-applied',
        status: before === 'healthy' ? 'unchanged' : 'updated',
        message: `Setup step ${step.id}`,
      });
    }
    return { outcomes, warnings: [] };
  }

  private async check(command: AgentSetupCommand, context: AgentSystemLifecycleContext) {
    const code = await this.execute(command, context, 'check');
    return code === 0 ? 'healthy' : code === 1 ? 'drift' : 'blocked';
  }

  private async execute(
    command: AgentSetupCommand,
    context: AgentSystemLifecycleContext,
    mode: 'check' | 'apply',
  ): Promise<number | null> {
    try {
      const result = await this.commands.run(command, {
        agentId: context.manifest.agent.id,
        workspaceDir: context.workspaceDir,
        mode,
      });
      return result.timedOut ? null : result.exitCode;
    } catch {
      return null;
    }
  }

  private fail(step: AgentSetupStep, code: string): never {
    throw new AgentSystemLifecycleError(
      'setup',
      code,
      `Setup step ${step.id} failed (${code}).`,
      undefined,
      undefined,
      step.id,
    );
  }
}
