import { constants } from 'node:os';

import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleExecutionContext,
  type AgentSystemLifecycleFinding,
  type AgentSystemLifecycleReconcileResult,
} from '../core/lifecycle-registry.ts';
import { SetupCommandError, type SetupCommandResult } from './setup-runner.ts';
import setupStepApplies from './setup-runtime.ts';
import type { AgentSetupCommand, AgentSetupStep } from '../manifest/setup-schema.ts';

type SetupStage = 'host' | 'agent';
type SetupPhase = 'check' | 'apply' | 'check after apply';
type SetupExecutionOutcome = { exitCode: number | null; reason: string };
const executionErrorCodes = new Set([
  'setup-agent-not-resolved',
  'setup-tool-unavailable',
  'setup-unsafe-executable',
  'setup-invalid-workspace',
  'setup-invalid-command-context',
  'setup-command-context-failed',
  'setup-shell-unavailable',
  'setup-executable-unavailable',
  'setup-cleanup-failed',
  'setup-execution-failed',
]);

function executionOutcome(result: SetupCommandResult): SetupExecutionOutcome {
  if (
    result.timedOut ||
    result.termination === 'timeout' ||
    result.termination === 'no-output-timeout'
  ) {
    return { exitCode: null, reason: 'timed out' };
  }
  if (result.termination === 'signal' || result.signal) {
    const signal =
      typeof result.signal === 'string' && Object.hasOwn(constants.signals, result.signal)
        ? result.signal
        : 'unknown';
    return { exitCode: null, reason: `terminated by signal ${signal}` };
  }
  if (
    (result.termination === undefined || result.termination === 'exit') &&
    Number.isSafeInteger(result.exitCode)
  ) {
    return { exitCode: result.exitCode, reason: `exited with exit code ${result.exitCode}` };
  }
  return { exitCode: null, reason: 'termination unknown' };
}

function failureMessage(
  step: AgentSetupStep,
  stage: SetupStage,
  phase: SetupPhase,
  outcome: SetupExecutionOutcome,
) {
  return `Setup step ${step.id} (setup-${stage}, ${phase}) failed: ${outcome.reason}.`;
}

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
      const check = step.check ? await this.check(step.check, step, context, owner) : undefined;
      const status = check?.status ?? 'manual';
      findings.push({
        component: 'setup',
        stepId: step.id,
        code: `setup-${status}`,
        status,
        message:
          check?.status === 'blocked'
            ? failureMessage(step, owner, 'check', check.outcome)
            : `Setup step ${step.id} is ${status}.`,
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
        const before = step.check ? await this.check(step.check, step, context, owner) : undefined;
        if (before?.status === 'blocked')
          this.fail(step, 'setup-check-blocked', owner, 'check', before.outcome);
        if (before?.status !== 'healthy') {
          const applied = await this.execute(step.apply, step, context, 'apply', owner);
          if (applied.exitCode !== 0)
            this.fail(step, 'setup-apply-failed', owner, 'apply', applied);
          if (step.check) {
            const after = await this.check(step.check, step, context, owner);
            if (after.status === 'blocked')
              this.fail(step, 'setup-check-blocked', owner, 'check after apply', after.outcome);
            if (after.status !== 'healthy')
              this.fail(step, 'setup-not-converged', owner, 'check after apply', after.outcome);
          }
        }
        outcomes.push({
          component: 'setup',
          stepId: step.id,
          code: before?.status === 'healthy' ? 'setup-unchanged' : 'setup-applied',
          status: before?.status === 'healthy' ? 'unchanged' : 'updated',
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
    const outcome = await this.execute(command, step, context, 'check', stage);
    const status =
      outcome.exitCode === 0 ? 'healthy' : outcome.exitCode === 1 ? 'drift' : 'blocked';
    return { status, outcome } as const;
  }

  private async execute(
    command: AgentSetupCommand,
    step: AgentSetupStep,
    context: AgentSystemLifecycleExecutionContext,
    mode: 'check' | 'apply',
    stage: SetupStage,
  ): Promise<SetupExecutionOutcome> {
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
      return executionOutcome(result);
    } catch (error) {
      context.signal?.throwIfAborted();
      await context.assertCurrent?.();
      const code =
        error instanceof SetupCommandError && executionErrorCodes.has(error.code)
          ? error.code
          : 'unknown';
      return { exitCode: null, reason: `execution failed (${code})` };
    }
  }

  private fail(
    step: AgentSetupStep,
    code: string,
    stage: SetupStage,
    phase: SetupPhase,
    outcome: SetupExecutionOutcome,
  ): never {
    throw new AgentSystemLifecycleError(
      'setup',
      code,
      failureMessage(step, stage, phase, outcome),
      undefined,
      undefined,
      step.id,
    );
  }
}
