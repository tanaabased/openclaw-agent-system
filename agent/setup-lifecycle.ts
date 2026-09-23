import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleExecutionContext,
  type AgentSystemLifecycleFinding,
  type AgentSystemLifecycleReconcileResult,
} from '../core/lifecycle-registry.ts';
import type SetupCommandService from './setup-command-service.ts';
import setupStepApplies from './setup-runtime.ts';
import type { AgentSetupCommand, AgentSetupStep } from '../manifest/setup-schema.ts';

/** Inspect applicable checks; reconcile ordered steps without rolling back external effects. */
export default class SetupLifecycleService {
  constructor(
    private readonly commands: Pick<SetupCommandService, 'run'> &
      Partial<Pick<SetupCommandService, 'prepare'>>,
  ) {}

  async inspect(
    context: AgentSystemLifecycleExecutionContext,
  ): Promise<AgentSystemLifecycleFinding[]> {
    const findings: AgentSystemLifecycleFinding[] = [];
    for (const step of context.manifest.setup?.steps ?? []) {
      if (!setupStepApplies(step, context.runtime)) {
        findings.push(this.notApplicable(step, context));
        continue;
      }
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
    context: AgentSystemLifecycleExecutionContext,
  ): Promise<AgentSystemLifecycleReconcileResult> {
    const outcomes: AgentSystemLifecycleReconcileResult['outcomes'] = [];
    try {
      if (context.manifest.setup?.steps.some((step) => setupStepApplies(step, context.runtime))) {
        await this.commands.prepare?.(context);
      }
    } catch {
      throw new AgentSystemLifecycleError(
        'setup',
        'setup-prerequisite-blocked',
        'Configured setup tools require available executables, credentials, and key sources.',
      );
    }
    for (const step of context.manifest.setup?.steps ?? []) {
      if (!setupStepApplies(step, context.runtime)) {
        outcomes.push(this.notApplicable(step, context));
        continue;
      }
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

  private notApplicable(step: AgentSetupStep, context: AgentSystemLifecycleExecutionContext) {
    return {
      component: 'setup',
      stepId: step.id,
      code: 'setup-not-applicable',
      status: 'skipped' as const,
      message: `Setup step ${step.id} does not apply to ${context.runtime}.`,
    };
  }

  private async check(command: AgentSetupCommand, context: AgentSystemLifecycleExecutionContext) {
    const code = await this.execute(command, context, 'check');
    return code === 0 ? 'healthy' : code === 1 ? 'drift' : 'blocked';
  }

  private async execute(
    command: AgentSetupCommand,
    context: AgentSystemLifecycleExecutionContext,
    mode: 'check' | 'apply',
  ): Promise<number | null> {
    context.signal?.throwIfAborted();
    await context.assertCurrent?.();
    try {
      const result = await this.commands.run(
        command,
        {
          agentId: context.manifest.agent.id,
          workspaceDir: context.workspaceDir,
          mode,
        },
        context.signal,
      );
      return result.timedOut ? null : result.exitCode;
    } catch {
      context.signal?.throwIfAborted();
      await context.assertCurrent?.();
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
