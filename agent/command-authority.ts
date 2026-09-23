import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import resolveGitWorktreeLayout from '../tools/git/worktree-layout.ts';
import isPathContained from '../utils/is-path-contained.ts';
import nodeErrorCode from '../utils/node-error-code.ts';
import type AgentManifestService from '../manifest/service.ts';
import AgentSystemToolError from '../api/error.ts';

export const agentCommandAuthorityEnvironmentName = 'AGENT_SYSTEM_EXEC_AUTHORITY';
export const agentCommandCapabilityEnvironmentName = 'AGENT_SYSTEM_EXEC_CAPABILITY';

const authorityIdPattern = /^[a-f0-9]{16}$/u;
const capabilityPattern = /^[A-Za-z0-9_-]{43}$/u;
const agentIdPattern = /^[a-z0-9][a-z0-9-]*$/u;
const maximumMessageBytes = 8_192;
const maximumCommandMessageBytes = 1_048_576;
const maximumLeases = 1_024;
const defaultLeaseLifetimeMs = 30 * 60 * 1_000;
const defaultSocketTimeoutMs = 2_000;

type AuthorityManifestService = Pick<AgentManifestService, 'loadForAgentId'> &
  Partial<Pick<AgentManifestService, 'loadForCommandDirectory'>>;

interface CapabilityLease {
  agentId: string;
  expiresAt: number;
}

interface AuthorityRequest {
  capability: string;
  cwd: string;
  command?: AgentBoundCommand;
}

export interface AgentBoundCommand {
  command: string;
  argv: string[];
  stdin?: string;
}

export interface AgentBoundCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface CodexCommandContext {
  codexHome: string;
  openClawStateDir?: string;
  threadId: string;
}

type AuthorityResponse =
  | {
      admittedWorkingDirectories: string[];
      agentId: string;
      status: 'allowed' | 'outside-agent-scope';
      workingDirectory: string;
      executesCommands?: true;
    }
  | { status: 'denied' };

export interface AgentCommandBinding {
  admittedWorkingDirectories: readonly string[];
  agentId: string;
  workingDirectory: string;
  executeCommand?(command: AgentBoundCommand): Promise<AgentBoundCommandResult>;
}

export type AgentCommandContext =
  | { status: 'managed'; binding: AgentCommandBinding }
  | { status: 'outside-agent-scope'; admittedWorkingDirectories: readonly string[] }
  | { status: 'unbound' };

export interface AgentCommandAuthorityDependencies {
  currentUid?: number;
  leaseLifetimeMs?: number;
  manifestService: AuthorityManifestService;
  now?: () => number;
  resolveCodexAgentId?(context: CodexCommandContext): Promise<string | undefined>;
  rootDir?: string;
  socketTimeoutMs?: number;
  /** Only an explicit setup owner supplies execution; Gateway authorities remain binding-only. */
  executeCommand?(
    command: AgentBoundCommand,
    binding: AgentCommandBinding,
    signal: AbortSignal,
  ): Promise<AgentBoundCommandResult>;
}

/** Mark one Gateway command descendant as explicitly unbound when authority is unavailable. */
export function deniedAgentCommandEnvironment(): Record<string, string> {
  return {
    [agentCommandAuthorityEnvironmentName]: 'denied',
    [agentCommandCapabilityEnvironmentName]: 'denied',
  };
}

function defaultAuthorityRoot(): string {
  return join(userInfo().homedir, '.config', 'tanaab', 'agent-system', 'runtime');
}

function isRequest(value: unknown): value is AuthorityRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<AuthorityRequest>;
  return (
    typeof request.capability === 'string' &&
    capabilityPattern.test(request.capability) &&
    typeof request.cwd === 'string' &&
    request.cwd.length > 0 &&
    request.cwd.length <= 4_096 &&
    !request.cwd.includes('\0') &&
    isAbsolute(request.cwd) &&
    (request.command === undefined || isCommand(request.command))
  );
}

function isCommand(value: unknown): value is AgentBoundCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Partial<AgentBoundCommand>;
  return (
    typeof command.command === 'string' &&
    /^[a-z][a-z0-9-]{0,63}$/u.test(command.command) &&
    Array.isArray(command.argv) &&
    command.argv.length <= 4_096 &&
    command.argv.every((argument) => typeof argument === 'string' && !argument.includes('\0')) &&
    (command.stdin === undefined ||
      (typeof command.stdin === 'string' && Buffer.byteLength(command.stdin) <= 65_536))
  );
}

function isCommandResult(value: unknown): value is AgentBoundCommandResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<AgentBoundCommandResult>;
  return (
    (result.exitCode === null ||
      (Number.isInteger(result.exitCode) &&
        Number(result.exitCode) >= 0 &&
        Number(result.exitCode) <= 255)) &&
    typeof result.stdout === 'string' &&
    typeof result.stderr === 'string'
  );
}

function isContextResponse(
  value: unknown,
): value is Exclude<AuthorityResponse, { status: 'denied' }> {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<Exclude<AuthorityResponse, { status: 'denied' }>>;
  return (
    (response.status === 'allowed' || response.status === 'outside-agent-scope') &&
    typeof response.agentId === 'string' &&
    agentIdPattern.test(response.agentId) &&
    typeof response.workingDirectory === 'string' &&
    isAbsolute(response.workingDirectory) &&
    !response.workingDirectory.includes('\0') &&
    Array.isArray(response.admittedWorkingDirectories) &&
    response.admittedWorkingDirectories.length > 0 &&
    response.admittedWorkingDirectories.every(
      (path) => typeof path === 'string' && isAbsolute(path) && !path.includes('\0'),
    ) &&
    (response.executesCommands === undefined ||
      (response.status === 'allowed' && response.executesCommands === true)) &&
    response.admittedWorkingDirectories.some((root) =>
      isPathContained(root, response.workingDirectory!),
    ) ===
      (response.status === 'allowed')
  );
}

async function readSocketMessage(
  socket: Socket,
  maximumBytes = maximumMessageBytes,
): Promise<string> {
  return new Promise<string>((resolveMessage, rejectMessage) => {
    let source = '';
    let settled = false;
    const cleanup = () => {
      socket.off('close', onClose);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectMessage(error);
    };
    const onClose = () =>
      rejectOnce(new Error('The Agent System command-authority connection closed early.'));
    const onData = (chunk: string | Buffer) => {
      source += String(chunk);
      if (Buffer.byteLength(source) > maximumBytes) {
        rejectOnce(new Error('The Agent System command-authority message is too large.'));
        return;
      }
      const newline = source.indexOf('\n');
      if (newline < 0 || settled) return;
      settled = true;
      cleanup();
      resolveMessage(source.slice(0, newline));
    };
    const onEnd = () =>
      rejectOnce(new Error('The Agent System command-authority message is incomplete.'));
    const onError = (error: Error) => rejectOnce(error);
    socket.setEncoding('utf8');
    socket.on('close', onClose);
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onError);
  });
}

/** Bind native-exec and OpenClaw Codex command descendants to the active agent. */
export default class AgentCommandAuthority {
  readonly #currentUid: number | undefined;
  readonly #leases = new Map<string, CapabilityLease>();
  readonly #leaseLifetimeMs: number;
  readonly #manifestService: AuthorityManifestService;
  readonly #now: () => number;
  readonly #resolveCodexAgentId?: (context: CodexCommandContext) => Promise<string | undefined>;
  readonly #rootDir: string;
  readonly #socketTimeoutMs: number;
  readonly #executeCommand?: AgentCommandAuthorityDependencies['executeCommand'];
  readonly #executions = new Map<
    Socket,
    { controller: AbortController; completion: Promise<unknown> }
  >();
  #authorityId?: string;
  #server?: Server;
  #socketPath?: string;

  constructor(dependencies: AgentCommandAuthorityDependencies) {
    this.#currentUid = dependencies.currentUid;
    this.#leaseLifetimeMs = dependencies.leaseLifetimeMs ?? defaultLeaseLifetimeMs;
    this.#manifestService = dependencies.manifestService;
    this.#now = dependencies.now ?? Date.now;
    this.#resolveCodexAgentId = dependencies.resolveCodexAgentId;
    this.#rootDir = resolve(dependencies.rootDir ?? defaultAuthorityRoot());
    this.#socketTimeoutMs = dependencies.socketTimeoutMs ?? defaultSocketTimeoutMs;
    this.#executeCommand = dependencies.executeCommand;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    await mkdir(this.#rootDir, { mode: 0o700, recursive: true });
    const root = await lstat(this.#rootDir);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      (this.#currentUid !== undefined && root.uid !== this.#currentUid) ||
      (root.mode & 0o077) !== 0 ||
      (await realpath(this.#rootDir)) !== this.#rootDir
    ) {
      throw new Error('The Agent System command-authority directory is unsafe.');
    }

    const authorityId = randomBytes(8).toString('hex');
    const socketPath = join(this.#rootDir, `${authorityId}.sock`);
    if (Buffer.byteLength(socketPath) > 96) {
      throw new Error('The Agent System command-authority socket path is too long.');
    }
    const server = createServer((socket) => this.#accept(socket));
    server.unref();
    server.listen(socketPath);
    try {
      await once(server, 'listening');
      await chmod(socketPath, 0o600);
    } catch (error) {
      server.close();
      await unlink(socketPath).catch(() => undefined);
      throw error;
    }
    this.#authorityId = authorityId;
    this.#server = server;
    this.#socketPath = socketPath;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    const socketPath = this.#socketPath;
    this.#server = undefined;
    this.#socketPath = undefined;
    this.#authorityId = undefined;
    this.#leases.clear();
    const executions = [...this.#executions.entries()];
    for (const [socket, execution] of executions) {
      execution.controller.abort();
      socket.destroy();
    }
    await Promise.allSettled(executions.map(([, execution]) => execution.completion));
    if (server) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (socketPath) await unlink(socketPath).catch(() => undefined);
  }

  issue(agentId: string): Record<string, string> {
    const normalizedAgentId = agentId.trim();
    if (!this.#server || !this.#authorityId || !agentIdPattern.test(normalizedAgentId)) {
      return deniedAgentCommandEnvironment();
    }
    this.#prune();
    while (this.#leases.size >= maximumLeases) {
      const oldest = this.#leases.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#leases.delete(oldest);
    }
    const capability = randomBytes(32).toString('base64url');
    this.#leases.set(capability, {
      agentId: normalizedAgentId,
      expiresAt: this.#now() + this.#leaseLifetimeMs,
    });
    return {
      [agentCommandAuthorityEnvironmentName]: this.#authorityId,
      [agentCommandCapabilityEnvironmentName]: capability,
    };
  }

  async resolve(
    environment: Readonly<NodeJS.ProcessEnv>,
    cwd: string,
  ): Promise<AgentCommandBinding | undefined> {
    const context = await this.classify(environment, cwd);
    if (context.status === 'outside-agent-scope') throw this.#unresolved();
    return context.status === 'managed' ? context.binding : undefined;
  }

  /** Invalid authority throws; only authenticated contexts may be outside agent scope. */
  async classify(
    environment: Readonly<NodeJS.ProcessEnv>,
    cwd: string,
  ): Promise<AgentCommandContext> {
    const authorityId = environment[agentCommandAuthorityEnvironmentName]?.trim();
    const capability = environment[agentCommandCapabilityEnvironmentName]?.trim();
    if (
      environment[agentCommandAuthorityEnvironmentName] === undefined &&
      environment[agentCommandCapabilityEnvironmentName] === undefined
    )
      return this.#resolveCodex(environment, cwd);
    if (
      !authorityId ||
      !capability ||
      !authorityIdPattern.test(authorityId) ||
      !capabilityPattern.test(capability) ||
      !isAbsolute(cwd)
    ) {
      throw this.#unresolved();
    }

    const socketPath = join(this.#rootDir, `${authorityId}.sock`);
    const socket = createConnection(socketPath);
    socket.setTimeout(this.#socketTimeoutMs, () => socket.destroy());
    try {
      await once(socket, 'connect');
      socket.write(`${JSON.stringify({ capability, cwd })}\n`);
      const response = JSON.parse(await readSocketMessage(socket)) as unknown;
      if (!isContextResponse(response)) throw this.#unresolved();
      if (response.status === 'outside-agent-scope') {
        return {
          status: 'outside-agent-scope',
          admittedWorkingDirectories: response.admittedWorkingDirectories,
        };
      }
      return {
        status: 'managed',
        binding: {
          admittedWorkingDirectories: response.admittedWorkingDirectories,
          agentId: response.agentId,
          workingDirectory: response.workingDirectory,
          ...(response.executesCommands === true
            ? {
                executeCommand: (command: AgentBoundCommand) =>
                  this.#runCommand(socketPath, capability, cwd, command),
              }
            : {}),
        },
      };
    } catch (error) {
      if (error instanceof AgentSystemToolError) throw error;
      throw this.#unresolved();
    } finally {
      socket.destroy();
    }
  }

  async #runCommand(
    socketPath: string,
    capability: string,
    cwd: string,
    command: AgentBoundCommand,
  ): Promise<AgentBoundCommandResult> {
    const request = JSON.stringify({ capability, cwd, command });
    if (!isCommand(command) || Buffer.byteLength(request) > maximumCommandMessageBytes)
      throw this.#unresolved();
    const socket = createConnection(socketPath);
    // The issuing setup scope owns the shorter execution deadline and closes this socket on expiry.
    socket.setTimeout(3_601_000, () => socket.destroy());
    try {
      await once(socket, 'connect');
      socket.write(`${request}\n`);
      const response: unknown = JSON.parse(
        await readSocketMessage(socket, maximumCommandMessageBytes),
      );
      if (!isCommandResult(response)) throw this.#unresolved();
      return response;
    } catch {
      throw new AgentSystemToolError(
        'execution_failed',
        'The bound Agent System command could not complete.',
      );
    } finally {
      socket.destroy();
    }
  }

  #accept(socket: Socket): void {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(this.#socketTimeoutMs, () => socket.destroy());
    void this.#respond(socket).catch(() => {
      if (!socket.destroyed) socket.end(`${JSON.stringify({ status: 'denied' })}\n`);
    });
  }

  async #respond(socket: Socket): Promise<void> {
    const source = await readSocketMessage(
      socket,
      this.#executeCommand ? maximumCommandMessageBytes : maximumMessageBytes,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      parsed = undefined;
    }
    const response = isRequest(parsed)
      ? await this.#authorize(parsed)
      : ({ status: 'denied' } as const);
    if (isRequest(parsed) && parsed.command && response.status === 'allowed') {
      if (
        !this.#executeCommand ||
        !this.#server ||
        socket.destroyed ||
        this.#executions.size >= 16
      ) {
        socket.end(`${JSON.stringify({ status: 'denied' })}\n`);
        return;
      }
      socket.setTimeout(0);
      const controller = new AbortController();
      const abort = () => controller.abort();
      socket.once('close', abort);
      const completion = Promise.resolve().then(() =>
        this.#executeCommand!(
          parsed.command!,
          {
            agentId: response.agentId,
            workingDirectory: response.workingDirectory,
            admittedWorkingDirectories: response.admittedWorkingDirectories,
          },
          controller.signal,
        ),
      );
      this.#executions.set(socket, { controller, completion });
      try {
        const result = await completion;
        const serialized = JSON.stringify(result);
        if (!isCommandResult(result) || Buffer.byteLength(serialized) > maximumCommandMessageBytes)
          throw this.#unresolved();
        socket.end(`${serialized}\n`);
      } finally {
        socket.off('close', abort);
        this.#executions.delete(socket);
      }
      return;
    }
    socket.end(
      `${JSON.stringify(response.status === 'allowed' && this.#executeCommand ? { ...response, executesCommands: true } : response)}\n`,
    );
  }

  async #authorize(request: AuthorityRequest): Promise<AuthorityResponse> {
    this.#prune();
    const lease = this.#leases.get(request.capability);
    if (!lease || lease.expiresAt <= this.#now()) return { status: 'denied' };
    return this.#authorizeAgent(lease.agentId, request.cwd);
  }

  async #authorizeAgent(agentId: string, cwd: string): Promise<AuthorityResponse> {
    const loaded = await this.#manifestService.loadForAgentId(agentId, 'service');
    if (loaded.status !== 'loaded' || loaded.manifest.agent.id !== agentId) {
      return { status: 'denied' };
    }

    const roots = [loaded.scope.workspaceDir];
    if (loaded.manifest.git?.worktrees) {
      try {
        const layout = resolveGitWorktreeLayout(
          loaded.scope.workspaceDir,
          loaded.manifest.git.worktrees,
        );
        roots.push(layout.worktreeRoot, ...Object.values(layout.localRepositories));
      } catch {
        return { status: 'denied' };
      }
    }
    const canonicalRoots = await Promise.all(
      roots.map(async (path) => {
        try {
          return await realpath(path);
        } catch (error) {
          if (nodeErrorCode(error) === 'ENOENT') return undefined;
          throw error;
        }
      }),
    );
    if (!canonicalRoots[0]) return { status: 'denied' };
    const admittedWorkingDirectories = canonicalRoots.filter(
      (path): path is string => path !== undefined,
    );
    let workingDirectory: string;
    try {
      workingDirectory = await realpath(cwd);
    } catch {
      return { status: 'denied' };
    }
    if (!admittedWorkingDirectories.some((root) => isPathContained(root, workingDirectory))) {
      const target = await this.#manifestService.loadForCommandDirectory?.(
        workingDirectory,
        'service',
      );
      if (
        !target ||
        (target.status !== 'unmanaged' &&
          (target.status !== 'loaded' || target.manifest.agent.id !== agentId))
      ) {
        return { status: 'denied' };
      }
      return {
        status: 'outside-agent-scope',
        admittedWorkingDirectories,
        agentId,
        workingDirectory,
      };
    }
    return {
      admittedWorkingDirectories,
      agentId,
      status: 'allowed',
      workingDirectory,
    };
  }

  async #resolveCodex(
    environment: Readonly<NodeJS.ProcessEnv>,
    cwd: string,
  ): Promise<AgentCommandContext> {
    const threadId = environment.CODEX_THREAD_ID?.trim();
    if (!threadId) {
      if (environment.CODEX_THREAD_ID !== undefined) throw this.#unresolved();
      return { status: 'unbound' };
    }
    const codexHome = environment.CODEX_HOME?.trim();
    const openClawStateDir = environment.OPENCLAW_STATE_DIR?.trim();
    if (
      !codexHome ||
      !isAbsolute(codexHome) ||
      codexHome.includes('\0') ||
      (openClawStateDir !== undefined &&
        (!isAbsolute(openClawStateDir) || openClawStateDir.includes('\0'))) ||
      threadId.length > 256 ||
      !isAbsolute(cwd) ||
      !this.#resolveCodexAgentId
    ) {
      throw this.#unresolved();
    }
    let agentId: string | undefined;
    try {
      agentId = await this.#resolveCodexAgentId({
        codexHome,
        ...(openClawStateDir === undefined ? {} : { openClawStateDir }),
        threadId,
      });
    } catch {
      throw this.#unresolved();
    }
    if (!agentId) {
      if (openClawStateDir !== undefined) throw this.#unresolved();
      return { status: 'unbound' };
    }
    if (!agentIdPattern.test(agentId)) throw this.#unresolved();
    let response: AuthorityResponse;
    try {
      response = await this.#authorizeAgent(agentId, cwd);
    } catch {
      throw this.#unresolved();
    }
    if (!isContextResponse(response)) throw this.#unresolved();
    if (response.status === 'outside-agent-scope') {
      return {
        status: 'outside-agent-scope',
        admittedWorkingDirectories: response.admittedWorkingDirectories,
      };
    }
    return {
      status: 'managed',
      binding: {
        admittedWorkingDirectories: response.admittedWorkingDirectories,
        agentId: response.agentId,
        workingDirectory: response.workingDirectory,
      },
    };
  }

  #prune(): void {
    const now = this.#now();
    for (const [capability, lease] of this.#leases) {
      if (lease.expiresAt <= now) this.#leases.delete(capability);
    }
  }

  #unresolved(): AgentSystemToolError {
    return new AgentSystemToolError(
      'agent_not_resolved',
      'Agent System could not verify the active agent command context.',
    );
  }
}
