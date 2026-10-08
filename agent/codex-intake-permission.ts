import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { automationHash } from './automation-hash.ts';
import { AutomationError, nativeObject } from './automation-gateway.ts';
import { connectCodexThreads } from './codex-thread-client.ts';
import runCodexSetupProcess from './codex-process-runner.ts';
import type { SetupProcessRunner } from './setup-runner.ts';
import PrivateStateFile from '../core/private-state-file.ts';
import { IntakeError } from '../channels/github/intake/record-store.ts';

interface PermissionContext {
  pluginData: string;
  workspace: string;
  codexHome: string;
}
export interface IntakePermissionDependencies {
  argv?: string[];
  policy?: (context: PermissionContext, argv: string[]) => Promise<unknown>;
  run?: SetupProcessRunner;
  connect?: typeof connectCodexThreads;
}

/** Inspect native rule sources and use Codex's evaluator; never parse or write Starlark. */
async function nativePolicy(
  context: PermissionContext,
  argv: string[],
  deps: IntakePermissionDependencies,
) {
  const connection = await (deps.connect ?? connectCodexThreads)(
    context.workspace,
    context.codexHome,
  );
  try {
    const config = await connection.request('config/read', {
      cwd: context.workspace,
      includeLayers: true,
    });
    const requirements = await connection.request('configRequirements/read', {});
    if (
      !Object.hasOwn(requirements, 'requirements') ||
      (requirements.requirements !== null &&
        (!nativeObject(requirements.requirements) || requirements.requirements.rules != null))
    )
      throw new IntakeError('intake-permission-managed-policy-unverified');
    if (!Array.isArray(config.layers)) throw new Error('missing native layers');
    const directories = new Set<string>();
    for (const layer of config.layers) {
      if (!nativeObject(layer) || !nativeObject(layer.name))
        throw new Error('invalid native layer');
      if (layer.disabledReason) continue;
      if (nativeObject(layer.config) && layer.config.rules != null)
        throw new IntakeError('intake-permission-managed-policy-unverified');
      const name = layer.name;
      if (typeof name.file === 'string') directories.add(join(dirname(name.file), 'rules'));
      else if (typeof name.dotCodexFolder === 'string')
        directories.add(join(name.dotCodexFolder, 'rules'));
      else if (name.type !== 'sessionFlags')
        throw new IntakeError('intake-permission-managed-policy-unverified');
    }
    const files: string[] = [];
    for (const directory of directories) {
      const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      for (const entry of entries.sort().filter((name) => name.endsWith('.rules'))) {
        if (files.length >= 100) throw new Error('rule inventory too large');
        const path = join(directory, entry);
        if ((await stat(path)).size > 1024 * 1024) throw new Error('rule too large');
        const content = await readFile(path, 'utf8');
        if (Buffer.byteLength(content) > 1024 * 1024) throw new Error('rule too large');
        files.push(path);
      }
    }
    if (!files.length) return { decision: null, matchedRules: [], revision: automationHash([]) };
    const result = await (deps.run ?? runCodexSetupProcess)(
      [
        'codex',
        'execpolicy',
        'check',
        '--resolve-host-executables',
        ...files.flatMap((file) => ['--rules', file]),
        '--',
        ...argv,
      ],
      {
        cwd: context.workspace,
        input: '',
        baseEnv: process.env,
        env: { CODEX_HOME: context.codexHome },
        timeoutMs: 15000,
        maxOutputBytes: 256 * 1024,
        maxCombinedOutputBytes: 512 * 1024,
        killGraceMs: 1000,
        killProcessTree: true,
        outputCapture: 'head',
      },
    );
    if (result.code !== 0 || result.termination !== 'exit' || result.stdoutTruncatedBytes)
      throw new Error('native policy evaluation failed');
    const parsed: unknown = JSON.parse(result.stdout);
    if (!nativeObject(parsed)) throw new Error('invalid policy result');
    return {
      ...parsed,
      revision: automationHash({ decision: parsed.decision, matchedRules: parsed.matchedRules }),
    };
  } finally {
    await connection.close();
  }
}

function receiptFile(context: PermissionContext) {
  return new PrivateStateFile({
    path: join(
      context.pluginData,
      `codex-intake-permission-${automationHash({ workspace: context.workspace, codexHome: context.codexHome })}.json`,
    ),
    directories: [context.pluginData],
    currentUid: process.getuid?.(),
    label: 'Codex intake permission acknowledgment',
    maximumBytes: 4096,
  });
}

/** Configured consent and operator-confirmed reload are distinct from observed unattended execution. */
export async function inspectCodexIntakePermission(
  context: PermissionContext,
  deps: IntakePermissionDependencies = {},
) {
  const argv = deps.argv ?? [
    process.execPath,
    resolve(process.argv[1]!),
    'intake',
    'scan',
    '--plugin-data',
    resolve(context.pluginData),
  ];
  let code: string | undefined;
  let digest: string | undefined;
  let configured = false;
  let reloadAcknowledged = false;
  try {
    const policy = await (deps.policy ?? ((ctx, command) => nativePolicy(ctx, command, deps)))(
      context,
      argv,
    );
    if (
      !nativeObject(policy) ||
      !Array.isArray(policy.matchedRules) ||
      typeof policy.revision !== 'string'
    )
      throw new Error('invalid permission evidence');
    const exact = policy.matchedRules.some(
      (rule) =>
        nativeObject(rule) &&
        nativeObject(rule.prefixRuleMatch) &&
        rule.prefixRuleMatch.decision === 'allow' &&
        JSON.stringify(rule.prefixRuleMatch.matchedPrefix) === JSON.stringify(argv),
    );
    if (policy.decision === 'forbidden' || policy.decision === 'prompt')
      code = 'intake-permission-denied';
    else if (policy.decision !== 'allow' || !exact) code = 'intake-permission-required';
    else {
      configured = true;
      digest = automationHash({ ...context, argv, revision: policy.revision });
      const raw = await receiptFile(context).read();
      const receipt: unknown = raw === undefined ? undefined : JSON.parse(raw);
      if (
        receipt !== undefined &&
        (!nativeObject(receipt) || receipt.version !== 1 || typeof receipt.digest !== 'string')
      )
        throw new Error('invalid permission acknowledgment');
      reloadAcknowledged = nativeObject(receipt) && receipt.digest === digest;
      if (!reloadAcknowledged)
        code =
          receipt === undefined ? 'intake-permission-reload-required' : 'intake-permission-stale';
    }
  } catch (error) {
    code =
      error instanceof IntakeError
        ? error.code
        : error instanceof AutomationError &&
            error.code === 'automation-thread-host-access-required'
          ? 'intake-permission-host-access-required'
          : 'intake-permission-inspection-unavailable';
  }
  return {
    status: code ? ('blocked' as const) : ('acknowledged' as const),
    ...(code ? { code } : {}),
    argv,
    digest,
    configured,
    reloadAcknowledged,
    execution: 'unverified' as const,
  };
}

/** Record a user's explicit reload acknowledgment; this grants no native permission. */
export async function acknowledgeCodexIntakePermission(
  context: PermissionContext,
  input: unknown,
  deps: IntakePermissionDependencies = {},
) {
  const inspection = await inspectCodexIntakePermission(context, deps);
  if (
    !nativeObject(input) ||
    input.confirmReload !== true ||
    !inspection.configured ||
    !inspection.digest ||
    input.digest !== inspection.digest ||
    (inspection.code !== undefined &&
      !['intake-permission-reload-required', 'intake-permission-stale'].includes(inspection.code))
  )
    throw new IntakeError('intake-permission-acknowledgment-required');
  await receiptFile(context).write(JSON.stringify({ version: 1, digest: inspection.digest }));
  return inspectCodexIntakePermission(context, deps);
}
