import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';

import { AutomationError, nativeObject } from './automation-gateway.ts';
import type { AutomationThreadAdapter } from './automation-threads.ts';

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

/** bound native app-server protocol, never scheduler files, generated turns, or a second scheduler. */
export async function connectCodexThreads(workspace: string, codexHome: string) {
  const child = spawn('codex', ['app-server'], {
    cwd: workspace,
    env: { ...process.env, CODEX_HOME: codexHome },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0;
  let buffer = '';
  let diagnosticTail = '';
  let hostAccessDenied = false;
  const pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const fail = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(
        new AutomationError(
          hostAccessDenied
            ? 'automation-thread-host-access-required'
            : 'automation-thread-transport-unavailable',
        ),
      );
    }
    pending.clear();
  };
  child.once('error', (error: NodeJS.ErrnoException) => {
    hostAccessDenied ||= error.code === 'EACCES' || error.code === 'EPERM';
    fail();
  });
  child.once('exit', fail);
  child.stdin.on('error', fail);
  child.stderr.on('data', (chunk: Buffer) => {
    diagnosticTail = (diagnosticTail + chunk.toString()).slice(-2048);
    hostAccessDenied ||= /permission denied|operation not permitted/iu.test(diagnosticTail);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) {
      fail();
      child.kill();
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
        fail();
        child.kill();
        return;
      }
      if (!nativeObject(message) || typeof message.id !== 'number') continue;
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      clearTimeout(item.timer);
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
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new AutomationError('automation-thread-request-timeout'));
        child.kill();
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  const close = async () => {
    fail();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, 1000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  };
  try {
    const initialized = await request('initialize', {
      clientInfo: { name: 'agent_system', version: '1' },
    });
    if (
      typeof initialized.codexHome !== 'string' ||
      (await realpath(initialized.codexHome)) !== (await realpath(codexHome))
    )
      throw new AutomationError('automation-thread-profile-mismatch');
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
  async function lookup(id: string) {
    let result: Record<string, unknown>;
    try {
      result = await request('thread/read', { threadId: id, includeTurns: false });
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
    if (
      thread.archived === true ||
      thread.ephemeral === true ||
      thread.canAcceptDirectInput === false ||
      (Array.isArray(thread.environments) &&
        thread.environments.some(
          (environment) => !nativeObject(environment) || environment.environmentId !== 'local',
        )) ||
      typeof thread.path !== 'string' ||
      thread.path.split(/[\\/]/u).includes('archived_sessions') ||
      !['idle', 'active', 'running', 'completed', 'notLoaded'].includes(String(thread.status.type))
    )
      throw new AutomationError('automation-thread-unavailable');
    verifyPermissions(await request('thread/resume', { threadId: id }));
    return {
      id,
      ...(typeof thread.name === 'string' ? { name: thread.name } : {}),
      ...(typeof thread.model === 'string' ? { model: thread.model } : {}),
      ...(typeof thread.reasoningEffort === 'string' ? { effort: thread.reasoningEffort } : {}),
    };
  }
  return {
    lookup,
    async create(record, saveId, fresh, settings) {
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
      return id;
    },
    async rename(id, name) {
      await request('thread/name/set', { threadId: id, name });
    },
  };
}
