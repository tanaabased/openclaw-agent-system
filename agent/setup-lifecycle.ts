import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleExecutionContext,
  type AgentSystemLifecycleFinding,
  type AgentSystemLifecycleReconcileResult,
} from '../core/lifecycle-registry.ts';
import type { SetupCommandResult } from './setup-runner.ts';
import setupStepApplies from './setup-runtime.ts';
import type { AgentSetupCommand, AgentSetupStep } from '../manifest/setup-schema.ts';

type SetupStage = 'host' | 'agent';

/** Inspect applicable checks; reconcile ordered steps without rolling back external effects. */
export default class SetupLifecycleService {
  constructor(
    private readonly commands: {
      prepare?(context: AgentSystemLifecycleExecutionContext): Promise<void>;
      run(
        command: AgentSetupCommand,
        target: { agentId: string; workspaceDir: string; mode?: 'check' | 'apply' },
        signal?: AbortSignal,
      ): Promise<SetupCommandResult>;
      runPreAgent?(
        command: AgentSetupCommand,
        target: { agentId: string; workspaceDir: string; mode?: 'check' | 'apply' },
        signal?: AbortSignal,
      ): Promise<SetupCommandResult>;
    },
  ) {}

  async inspect(
    context: AgentSystemLifecycleExecutionContext,
    stage?: SetupStage,
  ): Promise<AgentSystemLifecycleFinding[]> {
    const findings: AgentSystemLifecycleFinding[] = [];
    for (const [step, owner] of this.steps(context, stage)) {
      if (!setupStepApplies(step, context.runtime)) {
        findings.push(this.notApplicable(step, context));
        continue;
      }
      const status = step.check ? await this.check(step.check, step, context, owner) : 'manual';
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
    stage?: SetupStage,
  ): Promise<AgentSystemLifecycleReconcileResult> {
    const outcomes: AgentSystemLifecycleReconcileResult['outcomes'] = [];
    let prepared = false;
    const steps = this.steps(context, stage);
    for (const [index, [step, owner]] of steps.entries()) {
      try {
        if (!setupStepApplies(step, context.runtime)) {
          outcomes.push(this.notApplicable(step, context));
          continue;
        }
        if (!prepared && owner === 'agent') {
          try {
            await this.commands.prepare?.(context);
          } catch {
            throw new AgentSystemLifecycleError(
              'setup',
              'setup-prerequisite-blocked',
              'Configured setup tools require available executables, credentials, and key sources.',
            );
          }
          prepared = true;
        }
        const before = step.check ? await this.check(step.check, step, context, owner) : 'manual';
        if (before === 'blocked') this.fail(step, 'setup-check-blocked');
        if (before !== 'healthy') {
          const applied = await this.execute(step.apply, step, context, 'apply', owner);
          if (applied !== 0) this.fail(step, 'setup-apply-failed');
          if (step.check) {
            const after = await this.check(step.check, step, context, owner);
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
      } catch (error) {
        if (!(error instanceof AgentSystemLifecycleError)) throw error;
        throw new AgentSystemLifecycleError(
          error.component,
          error.code,
          error.rawMessage,
          error.cause === undefined ? undefined : { cause: error.cause },
          error.providerDiagnostic,
          error.stepId,
          {
            outcomes: [...outcomes],
            warnings: [],
            unattempted: steps.slice(index + 1).map(([remaining]) => ({
              component: 'setup',
              stepId: remaining.id,
            })),
          },
        );
      }
    }
    return { outcomes, warnings: [] };
  }

  private steps(
    context: AgentSystemLifecycleExecutionContext,
    stage?: SetupStage,
  ): Array<[AgentSetupStep, SetupStage]> {
    return [
      ...(stage === 'agent'
        ? []
        : (context.manifest.setupHost?.steps ?? []).map((step): [AgentSetupStep, SetupStage] => [
            step,
            'host',
          ])),
      ...(stage === 'host'
        ? []
        : (context.manifest.setup?.steps ?? []).map((step): [AgentSetupStep, SetupStage] => [
            step,
            'agent',
          ])),
    ];
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

  private async check(
    command: AgentSetupCommand,
    step: AgentSetupStep,
    context: AgentSystemLifecycleExecutionContext,
    stage: SetupStage,
  ) {
    const code = await this.execute(command, step, context, 'check', stage);
    return code === 0 ? 'healthy' : code === 1 ? 'drift' : 'blocked';
  }

  private async execute(
    command: AgentSetupCommand,
    step: AgentSetupStep,
    context: AgentSystemLifecycleExecutionContext,
    mode: 'check' | 'apply',
    stage: SetupStage,
  ): Promise<number | null> {
    context.signal?.throwIfAborted();
    await context.assertCurrent?.();
    try {
      const run = stage === 'host' ? this.commands.runPreAgent : this.commands.run;
      if (!run) throw new Error('Host setup execution is unavailable.');
      const result = await run.call(
        this.commands,
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
