import githubV3Migration from '../manifest/github-v3-migration.ts';
import workflowFailure, { workflowFailureScope } from './workflow-failure.ts';
import runCodexNotificationReset from './codex-notification-reset.ts';
import runCodexFeedback from './codex-feedback.ts';
import codexRuntimeRequest from './codex-runtime-request.ts';
import runCodexContinuation from './codex-continuation.ts';
import runCodexDelivery, { CodexDeliveryFailure } from './codex-delivery.ts';
import process from 'node:process';
import { codexInstanceStore } from './codex-assignment-claims.ts';
import { operateInstanceIdentity } from './instance-identity.ts';

import codexHeartbeat, { codexHeartbeatEnvelope } from './codex-heartbeat.ts';
import codexHostAccess from './codex-host-access.ts';
import codexIssueNotice from './codex-issue-notice.ts';
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
    throw new Error('expected exactly --plugin-data <path>; send JSON on stdin without --input');
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

let failureScope: ReturnType<typeof workflowFailureScope> | undefined;
async function readWorkflowCommand(route: string, args: string[]) {
  if (args.includes('--input'))
    throw new Error(
      'expected <action> [<operation>] --plugin-data <path>; send JSON on stdin without --input',
    );
  const result = codexRuntimeRequest(route, args, JSON.parse(await readStandardInput()));
  failureScope = workflowFailureScope('codex', route, result.request);
  return result;
}

export async function runCodexRuntime(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (command === 'migrate-github') {
    const inspection = await inspectCodexWorkspaceBinding(parsePluginData(args.slice(1)));
    if (
      inspection.status !== 'bound' ||
      inspection.preview.status !== 'ready' ||
      inspection.preview.manifest.status !== 'loaded'
    )
      throw new Error('migration-manifest-unavailable');
    const result = githubV3Migration(inspection.preview.manifest);
    writeJson(result);
    if (result.resolutions.length) process.exitCode = 1;
    return;
  }
  if (command === 'session-start') return runSessionStart();
  if (command === 'binding') return runBinding(args.slice(1));
  if (command === 'instance') {
    const action = args[1] ?? '';
    const pluginData = parsePluginData(args.slice(2));
    writeJson(
      await operateInstanceIdentity(
        codexInstanceStore(pluginData),
        action,
        JSON.parse(await readStandardInput()),
      ),
    );
    return;
  }
  if (command === 'feedback') {
    const { pluginData, request } = await readWorkflowCommand(command, args.slice(1));
    writeJson(await runCodexFeedback(pluginData, request));
    return;
  }
  if (command === 'continuation') {
    const { pluginData, request } = await readWorkflowCommand(command, args.slice(1));
    writeJson(await runCodexContinuation(pluginData, request));
    return;
  }
  if (command === 'delivery') {
    if (args[1] === '--help') {
      process.stdout.write(
        'Usage: delivery <prepare|publish|reconcile|compose|candidate|announce|present> --plugin-data <path>\nRequest data is JSON on stdin; action is visible in argv and stdin cannot change it; id is the retained managed issue receipt. Prepare returns a digest for publication within the verified implementation stage or current user direction; no separate publication approval is required. compose selects the reply skill; candidate prepares the issue announcement; announce publishes its exact digest or reconciles an uncertain post. Reconcile verifies native attachment; present renders the card and notices even when attachment is pending.\n',
      );
      return;
    }
    const { pluginData, request } = await readWorkflowCommand(command, args.slice(1));
    writeJson(await runCodexDelivery(pluginData, request));
    return;
  }
  if (command === 'dispatch') {
    if (args[1] === '--help') {
      process.stdout.write(
        'Usage: dispatch <action> [<operation>] --plugin-data <path>\nRequest data is JSON on stdin with a matching or omitted action: inspect, next, prepare, reconcile, context, present, result, handoff, report, retry-denied, reset, retire, or assessment context|result|present. Direct assessment uses an explicit issue target and existing checkout path in the current chat without assignment or intake activation; it never authorizes implementation or publication. Handoff previews the planning-to-implementation transition under live policy or native user direction; implementation includes ordinary PR delivery. Native scheduled dispatch requires authorized activation. Operator-only retry-denied requires a paused schedule and verified native rejection. Operator-only reset preserves a completed assessment whose recorded native turn finished, with no later turn, and permits reassessment only after a new assignment event. operator-only retire accepts an exact owned task, including open assigned work, and enters the existing safe retirement lifecycle immediately without eligibility wait or grace. native ownership, running work, preservation and current configuration still apply; incomplete archival or reclamation remains pending. For these operator actions, omit digest to preview, then supply the returned digest to apply. Assessment results never authorize implementation.\n',
      );
      return;
    }
    const { pluginData, request } = await readWorkflowCommand(command, args.slice(1));
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new Error('dispatch-action-invalid');
    const { action, ...input } = request as Record<string, unknown>;
    if (
      typeof action !== 'string' ||
      ![
        'assessment',
        'inspect',
        'next',
        'prepare',
        'reconcile',
        'context',
        'present',
        'result',
        'summary',
        'handoff',
        'report',
        'retry-denied',
        'reset',
        'retire',
      ].includes(action)
    )
      throw new Error('dispatch-action-invalid');
    writeJson(await runCodexDispatch(pluginData, action, input));
    return;
  }
  if (command === 'notifications') {
    if (args[1] !== 'reset') throw new Error('notification-reset-action-required');
    const pluginData = parsePluginData(args.slice(2));
    writeJson(await runCodexNotificationReset(pluginData, JSON.parse(await readStandardInput())));
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
        'Usage: intake <inspect|scan|quiet-response|failure-response> --plugin-data <path>\nInspect is read-only. Scan requires prior authorized native activation and persists admission evidence only. Quiet-response formats JSON polling outcomes from stdin without reading or writing state.\n',
      );
      return;
    }
    const pluginData = parsePluginData(args.slice(2));
    if (action === 'inspect') writeJson(await inspectCodexIntake(pluginData));
    else if (action === 'scan')
      writeJson(await runCodexIntake(pluginData, false, { threadId: process.env.CODEX_THREAD_ID }));
    else if (action === 'failure-response') {
      const input = JSON.parse(await readStandardInput()) as Record<string, unknown>;
      if (
        !input ||
        typeof input !== 'object' ||
        Object.keys(input).some((key) => !['automationId', 'code'].includes(key)) ||
        typeof input.automationId !== 'string' ||
        typeof input.code !== 'string' ||
        !/^[a-z][a-z0-9-]{0,127}$/u.test(input.code)
      )
        throw new Error('heartbeat-request-invalid');
      const notice = codexIssueNotice({ event: 'failure', changed: true, code: input.code });
      writeJson({
        status: 'failure',
        response: codexHeartbeatEnvelope(input.automationId, notice.message, true),
      });
    } else if (action === 'quiet-response')
      writeJson(codexHeartbeat(JSON.parse(await readStandardInput())));
    else throw new Error('expected intake inspect, scan, quiet-response, or failure-response');
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
    'expected session-start, binding, setup, automations, intake, dispatch, continuation, delivery, or model-routing command',
  );
}

runCodexRuntime().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown Agent System Codex failure';
  const evidence = workflowFailure(error, 'workflow-operation-failed');
  const details = codexHostAccess(error)
    ? { code: 'codex-host-access-required' }
    : error instanceof CodexDeliveryFailure
      ? {
          code: error.code,
          ...(error.pullRequest
            ? { workflowStatus: 'partially-delivered', pullRequest: error.pullRequest }
            : {}),
        }
      : error instanceof AgentSystemLifecycleError
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
          : /^(?:dispatch|continuation|workflow|delivery|github-delivery|assessment|assessment-result|heartbeat|notification-reset)-[a-z-]+$/u.test(
                message,
              )
            ? { code: message }
            : { code: evidence.code };
  const notice = ['intake', 'dispatch', 'continuation', 'delivery', 'model-routing'].includes(
    process.argv[2] ?? '',
  )
    ? codexIssueNotice({
        event: 'failure',
        changed: true,
        code: 'code' in details ? details.code : undefined,
        providerDiagnostic: evidence.providerDiagnostic,
      })
    : undefined;
  process.stderr.write(
    `${JSON.stringify({ status: 'error', ...failureScope, ...evidence, ...details, message: codexHostAccess(error) ? 'Native host approval is required to access private plugin state.' : message, ...(notice ? (process.argv[2] === 'delivery' ? { notices: error instanceof CodexDeliveryFailure ? error.notices : [notice] } : { notice }) : {}) })}\n`,
  );
  process.exitCode = 1;
});
