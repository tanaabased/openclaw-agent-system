import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, lstat, mkdir, realpath, unlink } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createConnection, createServer, type Server, type Socket } from 'node:net';

import resolveGitWorktreeLayout from '../tools/git/worktree-layout.ts';
import type AgentManifestService from './agent-manifest-service.ts';
import AgentSystemToolError from './tool-error.ts';

export const agentCommandAuthorityEnvironmentName = 'AGENT_SYSTEM_EXEC_AUTHORITY';
export const agentCommandCapabilityEnvironmentName = 'AGENT_SYSTEM_EXEC_CAPABILITY';

const authorityIdPattern = /^[a-f0-9]{16}$/u;
const capabilityPattern = /^[A-Za-z0-9_-]{43}$/u;
const agentIdPattern = /^[a-z0-9][a-z0-9-]*$/u;
const maximumMessageBytes = 8_192;
const maximumLeases = 1_024;
const defaultLeaseLifetimeMs = 30 * 60 * 1_000;
const defaultSocketTimeoutMs = 2_000;

type AuthorityManifestService = Pick<AgentManifestService, 'loadForAgentId'>;

interface CapabilityLease {
  agentId: string;
  expiresAt: number;
}

interface AuthorityRequest {
  capability: string;
  cwd: string;
}

export interface CodexCommandContext {
  codexHome: string;
  openClawStateDir: string;
  threadId: string;
}

type AuthorityResponse =
  | {
      admittedWorkingDirectories: string[];
      agentId: string;
      status: 'allowed';
      workingDirectory: string;
    }
  | { status: 'denied' };

export interface AgentCommandBinding {
  admittedWorkingDirectories: readonly string[];
  agentId: string;
  workingDirectory: string;
}

export interface AgentCommandAuthorityDependencies {
  currentUid?: number;
  leaseLifetimeMs?: number;
  manifestService: AuthorityManifestService;
  now?: () => number;
  resolveCodexAgentId?(context: CodexCommandContext): Promise<string | undefined>;
  rootDir?: string;
  socketTimeoutMs?: number;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
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
    isAbsolute(request.cwd)
  );
}

function isAllowedResponse(
  value: unknown,
): value is Extract<AuthorityResponse, { status: 'allowed' }> {
  if (!value || typeof value !== 'object') return false;
  const response = value as Partial<Extract<AuthorityResponse, { status: 'allowed' }>>;
  return (
    response.status === 'allowed' &&
    typeof response.agentId === 'string' &&
    agentIdPattern.test(response.agentId) &&
    typeof response.workingDirectory === 'string' &&
    isAbsolute(response.workingDirectory) &&
    Array.isArray(response.admittedWorkingDirectories) &&
    response.admittedWorkingDirectories.every(
      (path) => typeof path === 'string' && isAbsolute(path),
    )
  );
}

async function readSocketMessage(socket: Socket): Promise<string> {
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
      if (Buffer.byteLength(source) > maximumMessageBytes) {
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
    if (server) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (socketPath) await unlink(socketPath).catch(() => undefined);
  }

  issue(agentId: string): Record<string, string> | undefined {
    const normalizedAgentId = agentId.trim();
    if (!this.#server || !this.#authorityId || !agentIdPattern.test(normalizedAgentId)) {
      return undefined;
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
    const authorityId = environment[agentCommandAuthorityEnvironmentName]?.trim();
    const capability = environment[agentCommandCapabilityEnvironmentName]?.trim();
    if (!authorityId && !capability) return this.#resolveCodex(environment, cwd);
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
      if (!isAllowedResponse(response)) throw this.#unresolved();
      return {
        admittedWorkingDirectories: response.admittedWorkingDirectories,
        agentId: response.agentId,
        workingDirectory: response.workingDirectory,
      };
    } catch (error) {
      if (error instanceof AgentSystemToolError) throw error;
      throw this.#unresolved();
    } finally {
      socket.destroy();
    }
  }

  #accept(socket: Socket): void {
    socket.setTimeout(this.#socketTimeoutMs, () => socket.destroy());
    void this.#respond(socket).catch(() => {
      if (!socket.destroyed) socket.end(`${JSON.stringify({ status: 'denied' })}\n`);
    });
  }

  async #respond(socket: Socket): Promise<void> {
    const source = await readSocketMessage(socket);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      parsed = undefined;
    }
    const response = isRequest(parsed)
      ? await this.#authorize(parsed)
      : ({ status: 'denied' } as const);
    socket.end(`${JSON.stringify(response)}\n`);
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
    const admittedWorkingDirectories = (
      await Promise.all(
        roots.map(async (path) => {
          try {
            return await realpath(path);
          } catch (error) {
            if (errorCode(error) === 'ENOENT') return undefined;
            throw error;
          }
        }),
      )
    ).filter((path): path is string => path !== undefined);
    let workingDirectory: string;
    try {
      workingDirectory = await realpath(cwd);
    } catch {
      return { status: 'denied' };
    }
    if (!admittedWorkingDirectories.some((root) => isContained(root, workingDirectory))) {
      return { status: 'denied' };
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
  ): Promise<AgentCommandBinding | undefined> {
    const threadId = environment.CODEX_THREAD_ID?.trim();
    const openClawStateDir = environment.OPENCLAW_STATE_DIR?.trim();
    if (!threadId || !openClawStateDir) return undefined;
    const codexHome = environment.CODEX_HOME?.trim();
    if (
      !codexHome ||
      !isAbsolute(codexHome) ||
      !isAbsolute(openClawStateDir) ||
      codexHome.includes('\0') ||
      openClawStateDir.includes('\0') ||
      threadId.length > 256 ||
      !isAbsolute(cwd) ||
      !this.#resolveCodexAgentId
    ) {
      throw this.#unresolved();
    }
    let agentId: string | undefined;
    try {
      agentId = await this.#resolveCodexAgentId({ codexHome, openClawStateDir, threadId });
    } catch {
      throw this.#unresolved();
    }
    if (!agentId || !agentIdPattern.test(agentId)) throw this.#unresolved();
    let response: AuthorityResponse;
    try {
      response = await this.#authorizeAgent(agentId, cwd);
    } catch {
      throw this.#unresolved();
    }
    if (!isAllowedResponse(response)) throw this.#unresolved();
    return {
      admittedWorkingDirectories: response.admittedWorkingDirectories,
      agentId: response.agentId,
      workingDirectory: response.workingDirectory,
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
