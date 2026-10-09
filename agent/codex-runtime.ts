import process from 'node:process';

import { runCodexDispatch } from './codex-dispatch.ts';
import { inspectCodexIntake, runCodexIntake } from './codex-intake.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';

import {
  acknowledgeCodexAutomation,
  cancelCodexAutomation,
  inspectCodexAutomations,
  listCodexAutomations,
  codexAutomationRunGap,
  prepareCodexAutomation,
  syncCodexAutomationThreads,
} from './codex-automations.ts';
import { CodexAutomationError } from './codex-automation-state.ts';
import codexModelRouting from './codex-model-routing.ts';
import { RoutingError } from './model-routing.ts';

import {
  bindCodexWorkspace,
  inspectCodexWorkspaceBinding,
  previewCodexWorkspace,
  unbindCodexWorkspace,
  type CodexWorkspacePreview,
} from './codex-workspace-binding.ts';
import { createCodexSessionContext } from './codex-context.ts';
import { CodexSetupError, inspectCodexSetup, installCodexSetup } from './codex-setup.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';

interface SessionStartInput {
  hook_event_name?: unknown;
  source?: unknown;
}

const sessionStartSources = new Set(['startup', 'resume', 'clear', 'compact']);

interface BindingOptions {
  allowInactive: boolean;
  confirm: boolean;
  pluginData?: string;
  workspace?: string;
}

function parsePluginData(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--plugin-data' || !args[1]) {
    throw new Error('expected exactly --plugin-data <path>');
  }
  return args[1];
}

function parseBindingOptions(args: string[]): BindingOptions {
  const options: BindingOptions = { allowInactive: false, confirm: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--confirm') {
      if (options.confirm) throw new Error('--confirm may be supplied only once');
      options.confirm = true;
      continue;
    }
    if (option === '--allow-inactive') {
      if (options.allowInactive) throw new Error('--allow-inactive may be supplied only once');
      options.allowInactive = true;
      continue;
    }
    if (option !== '--plugin-data' && option !== '--workspace') {
      throw new Error(`unsupported binding option: ${option ?? ''}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    const key = option === '--plugin-data' ? 'pluginData' : 'workspace';
    if (options[key] !== undefined) throw new Error(`${option} may be supplied only once`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function summarizePreview(preview: CodexWorkspacePreview): Record<string, unknown> {
  if (preview.status === 'invalid-workspace') return preview;
  const manifest = preview.manifest;
  if (manifest.status === 'unmanaged') {
    return {
      status: 'ready',
      workspaceDir: preview.workspaceDir,
      manifest: { status: 'missing' },
    };
  }
  if (manifest.status === 'invalid') {
    return {
      status: 'ready',
      workspaceDir: preview.workspaceDir,
      manifest: {
        status: 'invalid',
        path: manifest.path,
        diagnostics: manifest.diagnostics.map(({ code, message }) => ({ code, message })),
      },
    };
  }
  return {
    status: 'ready',
    workspaceDir: preview.workspaceDir,
    manifest: {
      status: 'valid',
      path: manifest.path,
      digest: manifest.digest,
      agentId: manifest.manifest.agent.id,
      diagnostics: manifest.diagnostics.map(({ code, message }) => ({ code, message })),
    },
  };
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStandardInput(): Promise<string> {
  let contents = '';
  for await (const chunk of process.stdin) {
    contents += String(chunk);
    if (contents.length > 1024 * 1024) throw new Error('hook input is too large');
  }
  return contents;
}

async function runSessionStart(): Promise<void> {
  const input = JSON.parse(await readStandardInput()) as SessionStartInput;
  if (input.hook_event_name !== 'SessionStart' || typeof input.source !== 'string') {
    throw new Error('expected a SessionStart hook payload');
  }
  if (!sessionStartSources.has(input.source)) throw new Error('unsupported SessionStart source');
  const pluginRoot = process.env.PLUGIN_ROOT;
  const pluginData = process.env.PLUGIN_DATA;
  if (!pluginRoot || !pluginData) throw new Error('Codex did not provide plugin runtime paths');
  const additionalContext = await createCodexSessionContext({
    nodeExecutable: process.execPath,
    pluginData,
    pluginRoot,
    source: input.source as 'startup' | 'resume' | 'clear' | 'compact',
  });
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    })}\n`,
  );
}

async function runBinding(args: string[]): Promise<void> {
  const action = args[0];
  if (!action) throw new Error('binding action is required');
  const options = parseBindingOptions(args.slice(1));

  if (action === 'preview') {
    if (!options.workspace) throw new Error('--workspace is required');
    if (options.pluginData || options.confirm || options.allowInactive) {
      throw new Error('preview accepts only --workspace');
    }
    writeJson(summarizePreview(await previewCodexWorkspace(options.workspace)));
    return;
  }

  if (!options.pluginData) throw new Error('--plugin-data is required');
  if (action === 'inspect') {
    if (options.workspace || options.confirm || options.allowInactive) {
      throw new Error('inspect accepts only --plugin-data');
    }
    const inspection = await inspectCodexWorkspaceBinding(options.pluginData);
    writeJson(
      inspection.status === 'bound'
        ? {
            status: 'bound',
            path: inspection.path,
            binding: inspection.binding,
            preview: summarizePreview(inspection.preview),
          }
        : inspection,
    );
    return;
  }
  if (action === 'bind') {
    if (!options.workspace) throw new Error('--workspace is required');
    if (!options.confirm) throw new Error('binding changes require --confirm');
    const result = await bindCodexWorkspace(options.pluginData, options.workspace, {
      allowInactive: options.allowInactive,
    });
    writeJson({ ...result, preview: summarizePreview(result.preview) });
    return;
  }
  if (action === 'unbind') {
    if (options.workspace || options.allowInactive) {
      throw new Error('unbind accepts only --plugin-data and --confirm');
    }
    if (!options.confirm) throw new Error('binding changes require --confirm');
    writeJson(await unbindCodexWorkspace(options.pluginData));
    return;
  }

  throw new Error(`unsupported binding action: ${action}`);
}

async function runSetup(args: string[]): Promise<void> {
  const action = args[0];
  if (action !== 'inspect' && action !== 'install') {
    throw new Error('expected setup inspect or setup install');
  }
  const pluginData = parsePluginData(args.slice(1));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    writeJson(
      action === 'inspect'
        ? await inspectCodexSetup(pluginData, controller.signal)
        : await installCodexSetup(pluginData, controller.signal),
    );
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  }
}

export async function runCodexRuntime(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (command === 'session-start') return runSessionStart();
  if (command === 'binding') return runBinding(args.slice(1));
  if (command === 'dispatch') {
    if (args[1] === '--help') {
      process.stdout.write(
        'Usage: dispatch --plugin-data <path>\nRequests are JSON on stdin with action: inspect, next, prepare, reconcile, context, result, or retry-denied. Native scheduled dispatch requires authorized activation. Operator-only retry-denied requires a paused schedule and verified native rejection; omit digest to preview, then supply the returned digest to apply. Assessment results never authorize implementation.\n',
      );
      return;
    }
    const pluginData = parsePluginData(args.slice(1));
    const request: unknown = JSON.parse(await readStandardInput());
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('dispatch-action-invalid');
    const { action, ...input } = request as Record<string, unknown>;
    if (
      typeof action !== 'string' ||
      !['inspect', 'next', 'prepare', 'reconcile', 'context', 'result', 'retry-denied'].includes(
        action,
      )
    )
      throw new Error('dispatch-action-invalid');
    writeJson(await runCodexDispatch(pluginData, action, input));
    return;
  }
  if (command === 'model-routing') {
    const pluginData = parsePluginData(args.slice(1));
    writeJson(await codexModelRouting(pluginData, JSON.parse(await readStandardInput())));
    return;
  }
  if (command === 'intake') {
    const action = args[1];
    if (action === '--help') {
      process.stdout.write(
        'Usage: intake <inspect|scan> --plugin-data <path>\nInspect is read-only. Scan requires prior authorized native activation and persists admission evidence only.\n',
      );
      return;
    }
    const pluginData = parsePluginData(args.slice(2));
    if (action === 'inspect') writeJson(await inspectCodexIntake(pluginData));
    else if (action === 'scan') writeJson(await runCodexIntake(pluginData));
    else throw new Error('expected intake inspect or scan');
    return;
  }
  if (command === 'setup') return runSetup(args.slice(1));
  if (command === 'automations') {
    const action = args[1];
    if (action === '--help') {
      process.stdout.write(
        'Usage: automations <list|sync|run|runs|inspect|plan|threads-sync|prepare|acknowledge|cancel> --plugin-data <path>\nRequests are JSON on stdin; run and runs require id. Sync plans native app writes; run-now and execution/delivery history are unavailable.\n',
      );
      return;
    }
    if (
      ![
        'list',
        'sync',
        'run',
        'runs',
        'inspect',
        'plan',
        'prepare',
        'threads-sync',
        'acknowledge',
        'cancel',
      ].includes(action ?? '')
    )
      throw new Error('unknown automation operation');
    const pluginData = parsePluginData(args.slice(2));
    const input: unknown = JSON.parse(await readStandardInput());
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('expected an automation request');
    const request = input as Record<string, unknown>;
    if (
      Object.keys(request).some(
        (key) => !['projects', 'threads', 'digest', 'receipt', 'id'].includes(key),
      ) ||
      (request.threads !== undefined && !Array.isArray(request.threads))
    )
      throw new Error('invalid automation request');
    const inputs = {
      projects: request.projects,
      threads: request.threads as unknown[] | undefined,
    };
    if (action === 'list' || action === 'sync') {
      writeJson(await listCodexAutomations(pluginData, inputs));
      return;
    }
    if (action === 'run' || action === 'runs') {
      if (typeof request.id !== 'string') throw new Error('expected a manifest automation id');
      writeJson(await codexAutomationRunGap(pluginData, request.id, action));
      process.exitCode = 1;
      return;
    }
    if (action === 'inspect' || action === 'plan') {
      writeJson(await inspectCodexAutomations(pluginData, inputs));
      return;
    }
    if (typeof request.digest !== 'string') throw new Error('expected an approved plan digest');
    if (action === 'threads-sync')
      writeJson(await syncCodexAutomationThreads(pluginData, request.digest, inputs));
    else if (action === 'prepare')
      writeJson(await prepareCodexAutomation(pluginData, request.digest, inputs));
    else if (action === 'acknowledge')
      writeJson(await acknowledgeCodexAutomation(pluginData, request.digest, request.receipt));
    else if (action === 'cancel')
      writeJson(await cancelCodexAutomation(pluginData, request.digest));
    else
      throw new Error(
        'expected automations list, sync, run, runs, inspect, plan, prepare, acknowledge, or cancel',
      );
    return;
  }
  throw new Error(
    'expected session-start, binding, setup, automations, intake, dispatch, or model-routing command',
  );
}

runCodexRuntime().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown Agent System Codex failure';
  const details =
    error instanceof AgentSystemLifecycleError
      ? {
          component: error.component,
          code: error.code,
          ...(error.stepId === undefined ? {} : { stepId: error.stepId }),
        }
      : error instanceof IntakeError ||
          error instanceof CodexSetupError ||
          error instanceof RoutingError ||
          error instanceof CodexAutomationError
        ? { code: error.code }
        : /^(?:dispatch|assessment-result)-[a-z-]+$/u.test(message)
          ? { code: message }
          : {};
  process.stderr.write(`${JSON.stringify({ status: 'error', ...details, message })}\n`);
  process.exitCode = 1;
});
