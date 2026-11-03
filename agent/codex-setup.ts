import { delimiter } from 'node:path';
import { codexInstanceStore } from './codex-assignment-claims.ts';
import instanceIdentity from './instance-identity.ts';

import { inspectCodexIntake, inspectCodexPickup } from './codex-intake.ts';
import { inspectCodexAutomations } from './codex-automations.ts';
import type { CodexAutomationInputs } from './codex-automation-plan.ts';
import runCodexSetupProcess from './codex-process-runner.ts';
import {
  inspectCodexWorkspaceBinding,
  type CodexWorkspaceBindingInspection,
} from './codex-workspace-binding.ts';
import SetupLifecycleService from './setup-lifecycle.ts';
import createSetupCommandRunner, { type SetupProcessRunner } from './setup-runner.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleFinding,
} from '../core/lifecycle-registry.ts';
import type { AgentSetupCommand } from '../manifest/setup-schema.ts';
import { githubNotificationRuntimeDiagnostics } from '../channels/github/notification-policy.ts';
import setupStepApplies from './setup-runtime.ts';
import { automationHash } from './automation-hash.ts';

interface CodexSetupSnapshot {
  agentId: string;
  bindingPath: string;
  manifestDigest: string;
  manifestPath: string;
  workspaceDir: string;
  manifest: Extract<
    Extract<CodexWorkspaceBindingInspection, { status: 'bound' }>['preview'],
    { status: 'ready' }
  >['manifest'] & { status: 'loaded' };
}

export interface CodexSetupDependencies {
  automationInputs?: CodexAutomationInputs;
  codexHome?: string;
  baseEnvironment?: Readonly<NodeJS.ProcessEnv>;
  inspectBinding?: typeof inspectCodexWorkspaceBinding;
  runCommandWithTimeout?: SetupProcessRunner;
  temporaryDirectory?: string;
  writeDebug?: (value: string) => void;
}

export class CodexSetupError extends Error {
  override name = 'CodexSetupError';

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function unavailable(inspection: CodexWorkspaceBindingInspection): never {
  if (inspection.status === 'unbound') {
    throw new CodexSetupError('codex-workspace-unbound', 'No Codex workspace is bound.');
  }
  if (inspection.status === 'invalid') {
    throw new CodexSetupError(inspection.code, inspection.message);
  }
  if (inspection.preview.status === 'invalid-workspace') {
    throw new CodexSetupError(inspection.preview.code, inspection.preview.message);
  }
  if (inspection.preview.manifest.status === 'unmanaged') {
    throw new CodexSetupError(
      'manifest-missing',
      'The bound workspace has no agent.yaml manifest.',
    );
  }
  if (inspection.preview.manifest.status === 'invalid') {
    throw new CodexSetupError('manifest-invalid', 'The bound workspace manifest is invalid.');
  }
  throw new CodexSetupError('codex-setup-unavailable', 'Codex setup is unavailable.');
}

async function snapshot(
  pluginData: string,
  inspectBinding: typeof inspectCodexWorkspaceBinding,
): Promise<CodexSetupSnapshot> {
  const inspection = await inspectBinding(pluginData);
  if (
    inspection.status !== 'bound' ||
    inspection.preview.status !== 'ready' ||
    inspection.preview.manifest.status !== 'loaded'
  ) {
    unavailable(inspection);
  }
  const loaded = inspection.preview.manifest;
  return {
    agentId: loaded.manifest.agent.id,
    bindingPath: inspection.path,
    workspaceDir: inspection.preview.workspaceDir,
    manifestPath: loaded.path,
    manifestDigest: loaded.digest,
    manifest: loaded,
  };
}

function sameSnapshot(left: CodexSetupSnapshot, right: CodexSetupSnapshot): boolean {
  return (
    left.agentId === right.agentId &&
    left.bindingPath === right.bindingPath &&
    left.workspaceDir === right.workspaceDir &&
    left.manifestPath === right.manifestPath &&
    left.manifestDigest === right.manifestDigest
  );
}

function pauseWarnings(selected: CodexSetupSnapshot) {
  return selected.manifest.diagnostics
    .filter(({ code }) => code === 'github-notification-enabled-deprecated')
    .map(({ code, fieldPath, message }) => ({
      component: 'github-notifications',
      code,
      stepId: fieldPath,
      message,
    }));
}

const setupReports = new Set([
  'absent',
  'link-blocked',
  'link-failed',
  'link-needed',
  'prepare-failed',
  'prepared',
  'install-failed',
  'cache-failed',
]);

async function runtime(
  pluginData: string,
  signal: AbortSignal | undefined,
  dependencies: CodexSetupDependencies,
  reports?: string[],
) {
  const inspectBinding = dependencies.inspectBinding ?? inspectCodexWorkspaceBinding;
  const selected = await snapshot(pluginData, inspectBinding);
  const baseEnvironment = dependencies.baseEnvironment ?? process.env;
  const run = createSetupCommandRunner({
    baseEnvironment,
    inheritOpenClawEnvironment: false,
    runCommandWithTimeout: dependencies.runCommandWithTimeout ?? runCodexSetupProcess,
    writeDebug: dependencies.writeDebug ?? ((value) => process.stderr.write(value)),
    ...(dependencies.temporaryDirectory === undefined
      ? {}
      : { temporaryDirectory: dependencies.temporaryDirectory }),
  });
  const runStep = async (
    command: AgentSetupCommand,
    target: { workspaceDir: string },
    commandSignal?: AbortSignal,
  ) => {
    const result = await run(
      command,
      {
        workspaceDir: target.workspaceDir,
        executableDirectories: (baseEnvironment.PATH ?? '').split(delimiter),
        ...(reports ? { captureOutput: true } : {}),
      },
      commandSignal,
    );
    if (reports && !result.truncated) {
      for (const line of (result.output?.stdout ?? '').split('\n')) {
        const prefix = 'setup-report-v1 ';
        if (!line.startsWith(prefix)) continue;
        const code = line.slice(prefix.length);
        if (setupReports.has(code) && !reports.includes(code)) reports.push(code);
      }
    }
    return result;
  };
  const lifecycle = new SetupLifecycleService({ run: runStep, runPreAgent: runStep });
  const context = {
    manifest: selected.manifest.manifest,
    workspaceDir: selected.workspaceDir,
    runtime: 'codex' as const,
    ...(signal === undefined ? {} : { signal }),
    async assertCurrent() {
      const current = await snapshot(pluginData, inspectBinding);
      if (!sameSnapshot(selected, current)) {
        throw new CodexSetupError(
          'codex-setup-stale',
          'The Codex workspace binding or manifest changed during setup.',
        );
      }
    },
  };
  return { context, lifecycle, selected };
}

/** Inspect or reconcile one declared maintenance slice using the ordinary setup executor. */
export async function runCodexSetupScope(
  pluginData: string,
  action: 'inspect-scope' | 'install-scope',
  input: unknown,
  signal?: AbortSignal,
  dependencies: CodexSetupDependencies = {},
) {
  if (
    typeof input !== 'object' ||
    input === null ||
    !('scope' in input) ||
    typeof input.scope !== 'string' ||
    !/^(?:workspace|(?:host|agent):[a-z0-9]+(?:-[a-z0-9]+)*)$/u.test(input.scope) ||
    Object.keys(input).some((key) => key !== 'scope' && key !== 'digest') ||
    (action === 'inspect-scope'
      ? 'digest' in input
      : !('digest' in input) || typeof input.digest !== 'string')
  )
    throw new CodexSetupError('codex-setup-scope-invalid', 'Expected a declared setup scope.');

  const { scope } = input;
  const reports: string[] = [];
  const { context, lifecycle, selected } = await runtime(pluginData, signal, dependencies, reports);
  const manifest = { ...context.manifest };
  let stepCount = 0;
  for (const [field, owner] of [
    ['setupHost', 'host'],
    ['setup', 'agent'],
  ] as const) {
    const setup = manifest[field];
    if (!setup) continue;
    const steps = setup.steps.filter((step) =>
      scope === 'workspace'
        ? !step.independent
        : step.independent && scope === `${owner}:${step.id}` && setupStepApplies(step, 'codex'),
    );
    manifest[field] = { ...setup, steps };
    stepCount += steps.length;
  }
  if (scope !== 'workspace' && stepCount !== 1)
    throw new CodexSetupError(
      'codex-setup-scope-invalid',
      'The selected setup step is unavailable.',
    );

  const digest = automationHash({
    scope,
    agentId: selected.agentId,
    bindingPath: selected.bindingPath,
    workspaceDir: selected.workspaceDir,
    manifestPath: selected.manifestPath,
    manifestDigest: selected.manifestDigest,
  });
  const target = { ...context, manifest };
  if (action === 'inspect-scope') {
    const findings = await lifecycle.inspect(target);
    await context.assertCurrent();
    return { status: 'inspected' as const, scope, digest, findings, reports };
  }
  if (!('digest' in input) || input.digest !== digest)
    throw new CodexSetupError('codex-setup-stale', 'The inspected setup scope is stale.');
  try {
    const result = await lifecycle.reconcile(target);
    await context.assertCurrent();
    if (scope === 'workspace') {
      const instance = await instanceIdentity(codexInstanceStore(pluginData)).reconcile!(context);
      result.outcomes.push(
        ...instance.outcomes.map((outcome) => ({ ...outcome, component: 'instance-identity' })),
      );
    }
    return { status: 'reconciled' as const, scope, ...result, reports };
  } catch (error) {
    if (!(error instanceof AgentSystemLifecycleError)) throw error;
    await context.assertCurrent();
    return {
      status: 'failed' as const,
      scope,
      code: error.code,
      stepId: error.stepId,
      message: error.rawMessage,
      ...error.progress,
      reports,
    };
  }
}

/** inspect standalone setup and desired/saved automation state without applying repairs. */
export async function inspectCodexSetup(
  pluginData: string,
  signal?: AbortSignal,
  dependencies: CodexSetupDependencies = {},
) {
  const { context, lifecycle, selected } = await runtime(pluginData, signal, dependencies);
  const notificationDiagnostics = githubNotificationRuntimeDiagnostics(
    context.manifest.github?.notifications,
    'codex',
  );
  const intake = await inspectCodexIntake(pluginData, dependencies);
  return {
    status: 'inspected' as const,
    agentId: selected.agentId,
    workspaceDir: selected.workspaceDir,
    manifestDigest: selected.manifestDigest,
    intake,
    findings: [
      ...(await inspectCodexPickup(pluginData, dependencies)),
      ...(intake.storage && intake.storage.level !== 'normal'
        ? [
            {
              component: 'github-notifications',
              status: 'warning' as const,
              code: 'dispatch-storage-' + intake.storage.level,
              message: intake.storage.message,
            },
          ]
        : []),
      ...(await lifecycle.inspect(context)),
      ...(await instanceIdentity(codexInstanceStore(pluginData)).inspect!(context)).map(
        (finding) => ({ ...finding, component: 'instance-identity' }),
      ),
      ...pauseWarnings(selected).map((warning) => ({ ...warning, status: 'warning' as const })),
      ...notificationDiagnostics.map<AgentSystemLifecycleFinding>((diagnostic) => ({
        component: 'github-notifications',
        ...diagnostic,
      })),
    ],
    automations: await inspectCodexAutomations(
      pluginData,
      dependencies.automationInputs,
      dependencies,
    ),
  };
}

/** reconcile standalone setup and report automation work requiring native app sync. */
export async function installCodexSetup(
  pluginData: string,
  signal?: AbortSignal,
  dependencies: CodexSetupDependencies = {},
) {
  const { context, lifecycle, selected } = await runtime(pluginData, signal, dependencies);
  const notificationDiagnostics = githubNotificationRuntimeDiagnostics(
    context.manifest.github?.notifications,
    'codex',
  );
  const result = await lifecycle.reconcile(context);
  await context.assertCurrent();
  const instance = await instanceIdentity(codexInstanceStore(pluginData)).reconcile!(context);
  result.outcomes.push(
    ...instance.outcomes.map((outcome) => ({ ...outcome, component: 'instance-identity' })),
  );
  // Setup may replace this runtime. Automation inspection and sync must load the installed code.
  return {
    status: 'requires-native-app-sync' as const,
    agentId: selected.agentId,
    workspaceDir: selected.workspaceDir,
    manifestDigest: selected.manifestDigest,
    ...result,
    warnings: [
      ...result.warnings,
      ...pauseWarnings(selected),
      ...notificationDiagnostics.map(({ code, message }) => ({
        component: 'github-notifications',
        code,
        message,
      })),
    ],
    automations: { status: 'requires-fresh-inspection' as const },
  };
}
