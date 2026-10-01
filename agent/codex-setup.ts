import { delimiter } from 'node:path';

import { inspectCodexAutomations } from './codex-automations.ts';
import type { CodexAutomationInputs } from './codex-automation-plan.ts';
import runCodexSetupProcess from './codex-process-runner.ts';
import {
  inspectCodexWorkspaceBinding,
  type CodexWorkspaceBindingInspection,
} from './codex-workspace-binding.ts';
import SetupLifecycleService from './setup-lifecycle.ts';
import createSetupCommandRunner, { type SetupProcessRunner } from './setup-runner.ts';
import type { AgentSetupCommand } from '../manifest/setup-schema.ts';

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

async function runtime(
  pluginData: string,
  signal: AbortSignal | undefined,
  dependencies: CodexSetupDependencies,
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
  const runStep = (
    command: AgentSetupCommand,
    target: { workspaceDir: string },
    commandSignal?: AbortSignal,
  ) =>
    run(
      command,
      {
        workspaceDir: target.workspaceDir,
        executableDirectories: (baseEnvironment.PATH ?? '').split(delimiter),
      },
      commandSignal,
    );
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

/** inspect standalone setup and desired/saved automation state without applying repairs. */
export async function inspectCodexSetup(
  pluginData: string,
  signal?: AbortSignal,
  dependencies: CodexSetupDependencies = {},
) {
  const { context, lifecycle, selected } = await runtime(pluginData, signal, dependencies);
  return {
    status: 'inspected' as const,
    agentId: selected.agentId,
    workspaceDir: selected.workspaceDir,
    manifestDigest: selected.manifestDigest,
    findings: await lifecycle.inspect(context),
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
  const result = await lifecycle.reconcile(context);
  const automations = await inspectCodexAutomations(
    pluginData,
    dependencies.automationInputs,
    dependencies,
  );
  return {
    status:
      automations.status === 'aligned'
        ? ('installed' as const)
        : ('requires-native-app-sync' as const),
    agentId: selected.agentId,
    workspaceDir: selected.workspaceDir,
    manifestDigest: selected.manifestDigest,
    ...result,
    automations,
  };
}
