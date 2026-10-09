import { readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { codexIntakePolicy } from './codex-intake-policy.ts';
import runCodexSetupProcess from './codex-process-runner.ts';
import { inspectCodexWorkspaceBinding } from './codex-workspace-binding.ts';
import type { SetupProcessRunner } from './setup-runner.ts';
import { resolveToolExecutable } from '../api/cli-runner.ts';
import type { ConnectedGitHubAccountClient } from '../core/github-account-client.ts';
import IntakeRecordStore, {
  IntakeError,
  intakeLocation,
  intakeRemediation,
  type IntakeState,
} from '../channels/github/intake/record-store.ts';
import scanAssignments from '../channels/github/intake/scan-assignments.ts';
import { githubIdentityMatches } from '../channels/github/provider/work-item.ts';
import GitHubWorkEventApiClient from '../channels/github/provider/work-event-api-client.ts';
import GitHubWorkItemClient from '../channels/github/provider/work-item-client.ts';
import readItemContext from '../channels/github/provider/read-item-context.ts';
import { githubResponseIdentity } from '../channels/github/provider/work-event-normalization.ts';
import type { GitHubNotificationIntakeClient } from '../channels/github/provider/work-event-types.ts';

export interface CodexIntakeDependencies {
  codexHome?: string;
  now?: () => number;
  inspectBinding?: typeof inspectCodexWorkspaceBinding;
  connect?: (workspace: string, signal: AbortSignal) => Promise<GitHubNotificationIntakeClient>;
}

/** ambient host authorization only; no manifest environment, tokens, or managed gh configuration. */
export async function connectCodexGitHub(
  workspace: string,
  signal: AbortSignal,
  run: SetupProcessRunner = runCodexSetupProcess,
) {
  const executable = await resolveToolExecutable('gh', process.env.PATH ?? '');
  const execute: ConnectedGitHubAccountClient['execute'] = async (argv, stdin, options) => {
    const result = await run([executable, ...argv, '--hostname', 'github.com'], {
      cwd: workspace,
      baseEnv: process.env,
      env: { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' },
      input: stdin ?? '',
      timeoutMs: options?.timeoutMs ?? 30_000,
      maxOutputBytes: options?.maxOutputBytes ?? 512 * 1024,
      maxCombinedOutputBytes: options?.maxOutputBytes ?? 512 * 1024,
      killGraceMs: 1000,
      killProcessTree: true,
      outputCapture: 'head',
      signal,
    });
    return {
      stdout: result.stdout,
      stderr: '',
      exitCode: result.code,
      timedOut: result.termination !== 'exit',
      truncated: Boolean(result.stdoutTruncatedBytes || result.stderrTruncatedBytes),
    };
  };
  const result = await execute(['api', '/user', '--jq', '{login,nodeId:.node_id,type}']);
  if (result.exitCode !== 0 || result.timedOut || result.truncated)
    throw new IntakeError('intake-github-auth-unavailable');
  let identity;
  try {
    identity = githubResponseIdentity(JSON.parse(result.stdout), 'native account');
    if (identity.type !== 'User') throw new Error('unsupported account');
  } catch {
    throw new IntakeError('intake-github-identity-invalid');
  }
  const api = new GitHubWorkEventApiClient({ identity, execute });
  return Object.assign(new GitHubWorkItemClient(api), {
    getItemContext: (owner: string, name: string, number: number) =>
      readItemContext(api, owner, name, number, 'issue', true),
  });
}

export async function selectCodexIntake(pluginData: string, deps: CodexIntakeDependencies) {
  const inspection = await (deps.inspectBinding ?? inspectCodexWorkspaceBinding)(pluginData);
  if (
    inspection.status !== 'bound' ||
    inspection.preview.status !== 'ready' ||
    inspection.preview.manifest.status !== 'loaded'
  )
    throw new IntakeError('intake-binding-unavailable');
  const loaded = inspection.preview.manifest;
  const workspace = inspection.preview.workspaceDir;
  const policy = codexIntakePolicy(loaded.manifest);
  const requestedHome = resolve(
    deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  );
  const namespace = await realpath(requestedHome).catch(() => requestedHome);
  const store = new IntakeRecordStore(
    intakeLocation({
      runtime: 'codex',
      root: pluginData,
      namespace,
      workspaceDir: workspace,
      agentId: loaded.manifest.agent.id,
    }),
  );
  return {
    policy,
    store,
    workspace,
    agentId: loaded.manifest.agent.id,
    digest: loaded.digest,
    manifest: loaded.manifest,
    codexHome: namespace,
  };
}

async function retainedStore(pluginData: string, deps: CodexIntakeDependencies) {
  const requestedHome = resolve(
    deps.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  );
  const namespace = await realpath(requestedHome).catch(() => requestedHome);
  const binding = await (deps.inspectBinding ?? inspectCodexWorkspaceBinding)(pluginData);
  const names = await readdir(pluginData).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [] as string[];
    throw error;
  });
  if (names.length > 2000) throw new IntakeError('intake-state-invalid');
  const matches: IntakeRecordStore[] = [];
  for (const name of names.filter((name) => /^github-intake-[a-f0-9]{64}\.json$/u.test(name))) {
    const scope = name.slice('github-intake-'.length, -'.json'.length);
    const store = new IntakeRecordStore({
      root: resolve(pluginData),
      path: join(resolve(pluginData), name),
      scope,
    });
    const state = await store.read();
    if (
      !state ||
      (binding.status === 'bound' && state.workspaceDir !== binding.binding.workspaceDir)
    )
      continue;
    if (
      intakeLocation({
        runtime: 'codex',
        root: pluginData,
        namespace,
        workspaceDir: state.workspaceDir,
        agentId: state.agentId,
      }).scope === scope
    )
      matches.push(store);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function connectSelected(
  current: Awaited<ReturnType<typeof selectCodexIntake>>,
  deps: CodexIntakeDependencies,
  signal: AbortSignal,
) {
  if (!current.policy) throw new IntakeError('intake-policy-disabled');
  const { policy, username } = current.policy;
  const client = await (deps.connect ?? connectCodexGitHub)(current.workspace, signal);
  const pin = policy.issueAssignment?.allowed.find(
    (actor) => actor.login.toLowerCase() === username.toLowerCase(),
  );
  if (
    client.identity.login.toLowerCase() !== username.toLowerCase() ||
    (pin && pin.nodeId !== client.identity.nodeId)
  )
    throw new IntakeError('intake-github-identity-mismatch');
  return client;
}

/** authorized install verifies native identity before it prepares an active schedule write. */
export async function preflightCodexIntake(pluginData: string, deps: CodexIntakeDependencies = {}) {
  const current = await selectCodexIntake(pluginData, deps);
  const client = await connectSelected(current, deps, AbortSignal.timeout(30_000));
  const state = await current.store.read();
  if (state && !githubIdentityMatches(state.account, client.identity))
    throw new IntakeError('intake-account-changed');
  return { manifestDigest: current.digest };
}

export async function runCodexIntake(
  pluginData: string,
  activate = false,
  deps: CodexIntakeDependencies = {},
) {
  try {
    const current = await selectCodexIntake(pluginData, deps);
    if (!current.policy) throw new IntakeError('intake-policy-disabled');
    const { policy, digest } = current.policy;
    return await scanAssignments({
      store: current.store,
      workspaceDir: current.workspace,
      agentId: current.agentId,
      policy,
      policyDigest: digest,
      now: (deps.now ?? Date.now)(),
      activate,
      async connect(signal) {
        return connectSelected(
          current,
          deps,
          AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        );
      },
      async assertCurrent() {
        const fresh = await selectCodexIntake(pluginData, deps);
        if (
          fresh.digest !== current.digest ||
          fresh.store.location.scope !== current.store.location.scope
        )
          throw new IntakeError('intake-policy-changed');
      },
    });
  } catch (error) {
    if (
      !activate &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'private-state-file-lock-busy'
    )
      return { status: 'busy', changed: false };
    // a revoked policy cannot admit work, but its retained evidence can suppress repeated notices.
    if (
      activate ||
      !(error instanceof IntakeError) ||
      ![
        'intake-binding-unavailable',
        'intake-policy-disabled',
        'intake-policy-reconciliation-required',
      ].includes(error.code)
    )
      throw error;
    const store = await retainedStore(pluginData, deps);
    if (!store) throw error;
    return store.exclusive(async (state, save) => {
      if (!state) throw error;
      const now = (deps.now ?? Date.now)();
      const changed = state.blocker?.code !== error.code;
      if (changed)
        await save({ ...state, blocker: { code: error.code, since: now, retryAfter: now } });
      return { status: 'blocked', code: error.code, changed };
    });
  }
}

/** inspection neither authenticates nor changes state, and never starts a scan. */
export async function inspectCodexIntake(pluginData: string, deps: CodexIntakeDependencies = {}) {
  let state: IntakeState | undefined;
  let code: string | undefined;
  let context: { workspaceDir: string; scope: string } | undefined;
  try {
    const current = await selectCodexIntake(pluginData, deps);
    context = { workspaceDir: current.workspace, scope: current.store.location.scope };
    state = await current.store.read();
    code = !current.policy
      ? 'intake-policy-disabled'
      : !state
        ? 'intake-activation-required'
        : state.policyDigest !== current.policy.digest
          ? 'intake-policy-reconciliation-required'
          : state.blocker?.code;
  } catch (error) {
    state = await retainedStore(pluginData, deps)
      .then((store) => store?.read())
      .catch(() => undefined);
    code = error instanceof IntakeError ? error.code : 'intake-inspection-failed';
    if (state) context = { workspaceDir: state.workspaceDir, scope: state.scope };
  }
  return {
    version: 1,
    status: code ? 'blocked' : 'ready',
    ...(code ? { code, remediation: intakeRemediation(code) } : {}),
    ...context,
    baselineAt: state?.baselineAt ?? null,
    checkpoint: state?.checkpoint ?? null,
    blocker: state?.blocker ?? null,
    records: state?.records ?? [],
  };
}
