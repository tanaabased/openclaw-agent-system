import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpath } from 'node:fs/promises';

import { gte } from 'semver';

import { commandTerminationGraceMs, metadataCommandTimeoutMs } from '../api/cli-budget.ts';
import { AutomationError, nativeObject } from './automation-gateway.ts';
import type { AutomationThreadAdapter, AutomationThreadSettings } from './automation-threads.ts';

export class CodexThreadRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
export type CodexThreadRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface ThreadConnectionOptions {
  /** trusted caller's monotonic deadline, shared by initialization and subsequent requests. */
  deadline?: number;
  signal?: AbortSignal;
}
interface ThreadConnectionDependencies {
  start(workspace: string, codexHome: string): ChildProcessWithoutNullStreams;
  realpath(path: string): Promise<string>;
  now(): number;
  schedule(callback: () => void, milliseconds: number): () => void;
}
const connectionDependencies: ThreadConnectionDependencies = {
  start: (workspace, codexHome) =>
    spawn('codex', ['app-server'], {
      cwd: workspace,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  realpath,
  now: () => performance.now(),
  schedule(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** one cold app-server lifecycle budget, with shorter control calls and no native write replay. */
export async function connectCodexThreads(
  workspace: string,
  codexHome: string,
  options: ThreadConnectionOptions = {},
  dependencies: ThreadConnectionDependencies = connectionDependencies,
) {
  // reuse the existing two-minute codex prerequisite allowance; this is not latency-percentile calibration.
  const deadline = options.deadline ?? dependencies.now() + 120_000;
  const child = dependencies.start(workspace, codexHome);
  let sequence = 0;
  let settingsUpdateSupported = false;
  let buffer = '';
  let diagnosticTail = '';
  let hostAccessDenied = false;
  let failed: Error | undefined;
  let closing: Promise<void> | undefined;
  const pending = new Map<
    number,
    {
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
      cancel(): void;
    }
  >();
  const fail = (error?: Error) => {
    failed ??=
      error ??
      new AutomationError(
        hostAccessDenied
          ? 'automation-thread-host-access-required'
          : 'automation-thread-transport-unavailable',
      );
    for (const item of pending.values()) {
      item.cancel();
      item.reject(failed);
    }
    pending.clear();
  };
  const abort = () => {
    fail(new AutomationError('automation-thread-request-cancelled'));
    void close();
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    fail();
    options.signal?.removeEventListener('abort', abort);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    closing = new Promise<void>((resolve) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const cancel = dependencies.schedule(() => {
        child.kill('SIGKILL');
      }, commandTerminationGraceMs);
      child.once('close', () => {
        cancel();
        resolve();
      });
      child.kill();
    });
    return closing;
  };
  child.once('error', (error: NodeJS.ErrnoException) => {
    hostAccessDenied ||= error.code === 'EACCES' || error.code === 'EPERM';
    fail();
  });
  child.once('exit', () => fail());
  child.stdin.on('error', () => fail());
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticTail = (diagnosticTail + chunk.toString()).slice(-2048);
    hostAccessDenied ||= /permission denied|operation not permitted/iu.test(diagnosticTail);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) {
      void close();
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        void close();
        return;
      }
      if (!nativeObject(message) || typeof message.id !== 'number') continue;
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      item.cancel();
      if (
        nativeObject(message.error) &&
        typeof message.error.code === 'number' &&
        typeof message.error.message === 'string'
      )
        item.reject(new CodexThreadRpcError(message.error.code, message.error.message));
      else if (nativeObject(message.result)) item.resolve(message.result);
      else item.reject(new AutomationError('automation-thread-response-invalid'));
    }
  });
  const request: CodexThreadRequest = (method, params) =>
    new Promise((resolve, reject) => {
      if (method === 'thread/settings/update' && !settingsUpdateSupported) {
        reject(new AutomationError('automation-thread-settings-unsupported'));
        return;
      }
      if (failed) {
        reject(failed);
        return;
      }
      const remaining = Math.floor(deadline - dependencies.now());
      const lifecycle = [
        'initialize',
        'thread/start',
        'thread/resume',
        'thread/read',
        'thread/list',
        'thread/inject_items',
      ].includes(method);
      const timeoutMs = lifecycle ? remaining : Math.min(metadataCommandTimeoutMs, remaining);
      const timeout = () => {
        pending.delete(id);
        reject(new AutomationError('automation-thread-request-timeout'));
        void close();
      };
      const id = ++sequence;
      if (timeoutMs <= 0) {
        timeout();
        return;
      }
      const cancel = dependencies.schedule(timeout, timeoutMs);
      pending.set(id, { resolve, reject, cancel });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    const initialized = await request('initialize', {
      clientInfo: { name: 'agent_system', version: '1' },
      capabilities: { experimentalApi: true },
    });
    if (
      typeof initialized.codexHome !== 'string' ||
      (await dependencies.realpath(initialized.codexHome)) !==
        (await dependencies.realpath(codexHome))
    )
      throw new AutomationError('automation-thread-profile-mismatch');
    const version =
      typeof initialized.userAgent === 'string'
        ? initialized.userAgent.match(/\/(\d+\.\d+\.\d+)(?:[\s(]|$)/u)?.[1]
        : undefined;
    settingsUpdateSupported = Boolean(version && gte(version, '0.160.1'));
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    return { request, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export function codexThreadAdapter(
  request: CodexThreadRequest,
  workspace: string,
  verifyDurable?: (id: string) => Promise<Record<string, unknown>>,
  readDurable?: (id: string) => Promise<Record<string, unknown>>,
): AutomationThreadAdapter {
  const permissions = {
    approvalPolicy: 'on-request',
    approvalsReviewer: 'auto_review',
    sandbox: 'workspace-write',
  };
  function verifyPermissions(result: Record<string, unknown>) {
    if (
      result.approvalPolicy !== permissions.approvalPolicy ||
      !['auto_review', 'guardian_subagent'].includes(String(result.approvalsReviewer)) ||
      !nativeObject(result.sandbox) ||
      result.sandbox.type !== 'workspaceWrite'
    )
      throw new AutomationError('automation-thread-permissions-diverged');
  }
  async function lookup(id: string, fresh = false) {
    let result: Record<string, unknown>;
    try {
      result =
        fresh && readDurable
          ? await readDurable(id)
          : await request('thread/read', { threadId: id, includeTurns: false });
    } catch (error) {
      // native negative responses, not a UUID heuristic or a transport failure.
      if (
        error instanceof CodexThreadRpcError &&
        error.code === -32600 &&
        (error.message === `no rollout found for thread id ${id}` ||
          error.message.startsWith('invalid thread id:'))
      )
        return null;
      throw new AutomationError('automation-thread-lookup-failed');
    }
    const thread = result.thread;
    if (
      !nativeObject(thread) ||
      thread.id !== id ||
      typeof thread.cwd !== 'string' ||
      !nativeObject(thread.status)
    )
      throw new AutomationError('automation-thread-response-invalid');
    if ((await realpath(thread.cwd).catch(() => '')) !== workspace)
      throw new AutomationError('automation-thread-workspace-mismatch');
    const archived =
      thread.archived === true ||
      (typeof thread.path === 'string' &&
        thread.path.split(/[\\/]/u).includes('archived_sessions'));
    if (
      thread.ephemeral === true ||
      (thread.canAcceptDirectInput === false && !archived) ||
      (Array.isArray(thread.environments) &&
        thread.environments.some(
          (environment) => !nativeObject(environment) || environment.environmentId !== 'local',
        )) ||
      typeof thread.path !== 'string' ||
      !['idle', 'active', 'running', 'completed', 'notLoaded'].includes(String(thread.status.type))
    )
      throw new AutomationError('automation-thread-unavailable');
    return {
      id,
      archived,
      ...(typeof thread.name === 'string' ? { name: thread.name } : {}),
      ...(typeof thread.model === 'string' ? { model: thread.model } : {}),
      ...(typeof thread.reasoningEffort === 'string' ? { effort: thread.reasoningEffort } : {}),
    };
  }
  async function validateSettings(settings: AutomationThreadSettings, currentModel?: string) {
    const desiredModel = settings.model ?? currentModel;
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await request('model/list', {
        limit: 100,
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      });
      if (!Array.isArray(result.data))
        throw new AutomationError('automation-thread-response-invalid');
      const model = result.data.find(
        (item) =>
          nativeObject(item) &&
          (desiredModel ? item.model === desiredModel : item.isDefault === true),
      );
      if (nativeObject(model)) {
        if (
          settings.effort &&
          (!Array.isArray(model.supportedReasoningEfforts) ||
            !model.supportedReasoningEfforts.some(
              (item) => nativeObject(item) && item.reasoningEffort === settings.effort,
            ))
        )
          throw new AutomationError('automation-effort-unsupported');
        return;
      }
      if (typeof result.nextCursor !== 'string') break;
      cursor = result.nextCursor;
    }
    throw new AutomationError('automation-model-unsupported');
  }
  return {
    lookup,
    lookupFresh: (id) => lookup(id, true),
    validateSettings: (settings, current) => validateSettings(settings, current?.model),
    async create(record, saveId, fresh, settings) {
      if (settings?.model || settings?.effort) await validateSettings(settings);
      if (!record.nativeId && !fresh)
        throw new AutomationError('automation-thread-create-ambiguous');
      let id = record.nativeId;
      if (!id) {
        const result = await request('thread/start', {
          cwd: workspace,
          ephemeral: false,
          ...permissions,
          ...(settings?.model ? { model: settings.model } : {}),
          ...(settings?.effort ? { config: { model_reasoning_effort: settings.effort } } : {}),
          threadSource: `agent-system:${record.key}`,
        });
        if (!nativeObject(result.thread) || typeof result.thread.id !== 'string')
          throw new AutomationError('automation-thread-response-invalid');
        id = result.thread.id;
        await saveId(id);
        verifyPermissions(result);
      } else {
        // known identity can resume; loss before durable materialization remains a recovery barrier.
        verifyPermissions(await request('thread/resume', { threadId: id, ...permissions }));
      }
      await request('thread/inject_items', {
        threadId: id,
        items: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Agent System setup: this conversation is reserved for a scheduled automation. No scheduled work has run.',
              },
            ],
          },
        ],
      });
      await request('thread/unsubscribe', { threadId: id });
      verifyPermissions(
        verifyDurable ? await verifyDurable(id) : await request('thread/resume', { threadId: id }),
      );
      await request('thread/unsubscribe', { threadId: id });
      return id;
    },
    async updateSettings(current, settings) {
      if (!readDurable) throw new AutomationError('automation-thread-settings-unsupported');
      await validateSettings(settings, current.model);
      let resumed = false;
      try {
        // native writer custody rejects a concurrent owner, including a desktop-loaded thread.
        await request('thread/resume', { threadId: current.id });
        resumed = true;
        const latest = await lookup(current.id);
        if (
          !latest ||
          latest.archived ||
          latest.model !== current.model ||
          latest.effort !== current.effort
        )
          throw new AutomationError('automation-thread-settings-conflict');
        await request('thread/settings/update', { threadId: current.id, ...settings });
      } catch (error) {
        if (error instanceof CodexThreadRpcError) {
          if (
            error.code === -32600 &&
            error.message === `thread ${current.id} already has an active writer`
          )
            throw new AutomationError('automation-thread-settings-busy');
          if (error.code === -32601)
            throw new AutomationError('automation-thread-settings-unsupported');
          if (error.code === -32600 || error.code === -32602)
            throw new AutomationError('automation-thread-settings-denied');
        }
        throw error;
      } finally {
        if (resumed) await request('thread/unsubscribe', { threadId: current.id });
      }
    },
    async rename(id, name) {
      await request('thread/name/set', { threadId: id, name });
    },
  };
}
