import { satisfies, valid, validRange } from 'semver';

import type { CodexPluginRequirement } from '../core/codex-plugin-metadata.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleContext,
  type AgentSystemLifecycleExecutionContext,
  type AgentSystemLifecycleFinding,
} from '../core/lifecycle-registry.ts';

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
interface PluginRecord {
  id: string;
  version?: string;
  origin?: string;
  rootDir?: string;
  enabled: boolean;
  status?: string;
}
interface PluginInspection {
  plugin: PluginRecord;
  install?: { source?: string; version?: string };
  compatibility?: Array<{ severity: string; code: string }>;
}
type Finding = Omit<AgentSystemLifecycleFinding, 'component'>;

export interface CodexPluginLifecycleDependencies {
  readRequirement(): Promise<CodexPluginRequirement | undefined>;
  readPluginPackage(rootDir: string): Promise<{
    name?: string;
    version?: string;
    openclaw?: { compat?: { pluginApi?: string }; install?: { minHostVersion?: string } };
  }>;
  runOpenClawCommand(args: string[], cwd: string, signal?: AbortSignal): Promise<CommandResult>;
  withLock<T>(run: () => Promise<T>): Promise<T>;
}

function executionContext(
  context: AgentSystemLifecycleContext,
): AgentSystemLifecycleExecutionContext | undefined {
  return 'runtime' in context && context.runtime === 'openclaw'
    ? (context as AgentSystemLifecycleExecutionContext)
    : undefined;
}

function safeVersion(value: unknown): string {
  return typeof value === 'string' && value.length <= 100 && valid(value) === value
    ? value
    : 'unknown';
}

// upstream output can include credentials, paths, and arbitrary plugin prose; report only bounded facts.
function commandFailure(operation: string, result?: CommandResult): AgentSystemLifecycleError {
  const code = result && Number.isSafeInteger(result.code) ? result.code : 'unknown';
  const output = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`.slice(-65_536);
  const category = /timed?\s*out|timeout/i.test(output)
    ? 'timeout'
    : /EACCES|EPERM|permission denied/i.test(output)
      ? 'permission'
      : /ENOTFOUND|ECONN|network|fetch failed/i.test(output)
        ? 'transport'
        : /install.?policy|capabilit|denied|blocked/i.test(output)
          ? 'policy'
          : 'unknown';
  return new AgentSystemLifecycleError(
    'codex-plugin',
    `codex-plugin-${operation}-failed`,
    `Codex prerequisite ${operation} failed (exit=${code}; category=${category}). Inspect OpenClaw plugin diagnostics, then rerun install; upstream output was withheld.`,
  );
}

function finding(
  code: string,
  message: string,
  remediation: string,
  status: Finding['status'] = 'blocked',
): Finding {
  return { code: `codex-plugin-${code}`, message, remediation, status };
}

/** one shared openclaw prerequisite, independently inspected and reconciled only by install. */
export default function createCodexPluginLifecycleContribution(
  dependencies: CodexPluginLifecycleDependencies,
): AgentSystemLifecycleContribution {
  async function command(
    context: AgentSystemLifecycleExecutionContext,
    operation: string,
    args: string[],
  ): Promise<CommandResult> {
    context.signal?.throwIfAborted();
    await context.assertCurrent?.();
    let result: CommandResult;
    try {
      result = await dependencies.runOpenClawCommand(args, context.workspaceDir, context.signal);
    } catch {
      context.signal?.throwIfAborted();
      throw commandFailure(operation);
    }
    context.signal?.throwIfAborted();
    await context.assertCurrent?.();
    if (result.code !== 0) throw commandFailure(operation, result);
    return result;
  }

  async function inspect(
    context: AgentSystemLifecycleExecutionContext,
  ): Promise<{ requirement: CodexPluginRequirement; finding: Finding }> {
    const requirement = await dependencies.readRequirement();
    if (!requirement)
      throw new AgentSystemLifecycleError(
        'codex-plugin',
        'codex-plugin-declaration-invalid',
        'Agent System package metadata has no valid exact Codex prerequisite. Reinstall a valid Agent System package.',
      );
    const hostOutput = (await command(context, 'host-inspection', ['--version'])).stdout.trim();
    const hostVersion = safeVersion(
      hostOutput.match(
        /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:\s|$)/,
      )?.[1],
    );
    const expected = `Expected ${requirement.spec}; host >=${requirement.minimumHostVersion}; actual host ${hostVersion}`;
    if (
      hostVersion === 'unknown' ||
      !satisfies(hostVersion, `>=${requirement.minimumHostVersion}`)
    ) {
      return {
        requirement,
        finding: finding(
          'host-incompatible',
          `${expected}.`,
          `Upgrade OpenClaw to >=${requirement.minimumHostVersion} before installing or enabling Codex.`,
        ),
      };
    }
    let plugins: PluginRecord[];
    try {
      const inventory = JSON.parse(
        (await command(context, 'inspection', ['plugins', 'list', '--json'])).stdout,
      ) as { plugins?: PluginRecord[] };
      if (!Array.isArray(inventory.plugins)) throw new Error('invalid inventory');
      plugins = inventory.plugins.filter((plugin) => plugin.id === 'codex');
    } catch (error) {
      if (error instanceof AgentSystemLifecycleError) throw error;
      throw commandFailure('inspection');
    }
    if (plugins.length === 0)
      return {
        requirement,
        finding: finding(
          'missing',
          `${expected}; actual plugin missing.`,
          'Run openclaw agent-system install to provision the shared prerequisite.',
          'drift',
        ),
      };
    if (plugins.length !== 1)
      return {
        requirement,
        finding: finding(
          'conflict',
          `${expected}; multiple Codex installations were discovered.`,
          'Resolve duplicate shared Codex installations explicitly, then rerun install.',
        ),
      };
    let report: PluginInspection;
    try {
      report = JSON.parse(
        (await command(context, 'inspection', ['plugins', 'inspect', 'codex', '--json'])).stdout,
      ) as PluginInspection;
    } catch (error) {
      if (error instanceof AgentSystemLifecycleError) throw error;
      throw commandFailure('inspection');
    }
    const plugin = report.plugin;
    if (!plugin || plugin.id !== 'codex' || typeof plugin.enabled !== 'boolean')
      throw commandFailure('inspection');
    const actual = safeVersion(plugin.version);
    const versions = `${expected}; actual plugin ${actual}`;
    if (
      actual !== requirement.version ||
      plugin.origin !== 'global' ||
      !plugin.rootDir ||
      !report.install ||
      report.install.source === 'path' ||
      safeVersion(report.install.version) !== actual
    ) {
      return {
        requirement,
        finding: finding(
          'conflict',
          `${versions}; shared installation does not match the required version or managed source.`,
          `Review openclaw plugins inspect codex --json and explicitly reconcile the shared installation to ${requirement.spec}; agent installation will not replace it.`,
        ),
      };
    }
    let metadata: Awaited<ReturnType<CodexPluginLifecycleDependencies['readPluginPackage']>>;
    try {
      metadata = await dependencies.readPluginPackage(plugin.rootDir);
    } catch {
      throw commandFailure('inspection');
    }
    if (metadata.name !== '@openclaw/codex' || metadata.version !== actual) {
      return {
        requirement,
        finding: finding(
          'conflict',
          `${versions}; installed package identity disagrees with OpenClaw discovery.`,
          'Repair the shared Codex package identity explicitly, then rerun install.',
        ),
      };
    }
    const ranges = [
      metadata.openclaw?.compat?.pluginApi,
      metadata.openclaw?.install?.minHostVersion,
    ].filter((value) => value !== undefined);
    if (
      !metadata.openclaw?.compat?.pluginApi ||
      ranges.some(
        (range) =>
          typeof range !== 'string' || !validRange(range) || !satisfies(hostVersion, range),
      ) ||
      report.compatibility?.some(({ severity }) => severity === 'error') ||
      plugin.status === 'error'
    ) {
      return {
        requirement,
        finding: finding(
          'incompatible',
          `${versions}; installed plugin compatibility or discovery is blocked.`,
          'Inspect openclaw plugins inspect codex --json and resolve the reported host/plugin incompatibility before enabling it.',
        ),
      };
    }
    return {
      requirement,
      finding: plugin.enabled
        ? finding('ready', `${versions}; enabled shared prerequisite.`, '', 'healthy')
        : finding(
            'disabled',
            `${versions}; shared plugin disabled.`,
            'Run openclaw agent-system install to enable the matching shared prerequisite.',
            'drift',
          ),
    };
  }

  return {
    id: 'codex-plugin',
    isConfigured: () => true,
    async inspect(input) {
      const context = executionContext(input);
      if (!context) return [];
      try {
        return [(await inspect(context)).finding];
      } catch (error) {
        context.signal?.throwIfAborted();
        return [
          finding(
            error instanceof AgentSystemLifecycleError
              ? error.code.replace(/^codex-plugin-/, '')
              : 'inspection-failed',
            error instanceof AgentSystemLifecycleError
              ? error.message
              : 'Codex prerequisite inspection failed; upstream details were withheld.',
            'Restore OpenClaw plugin inspection, then rerun Doctor.',
          ),
        ];
      }
    },
    async reconcile(input) {
      const context = executionContext(input);
      if (!context) return { outcomes: [] };
      const preflight = await inspect(context);
      if (preflight.finding.status === 'blocked') {
        throw new AgentSystemLifecycleError(
          'codex-plugin',
          preflight.finding.code,
          `${preflight.finding.message} ${preflight.finding.remediation}`,
        );
      }
      // serialize agent system installs per profile; never write a parallel plugin ledger.
      return dependencies.withLock(async () => {
        const current = await inspect(context);
        const { requirement, finding: state } = current;
        if (state.status === 'blocked')
          throw new AgentSystemLifecycleError(
            'codex-plugin',
            state.code,
            `${state.message} ${state.remediation}`,
          );
        if (state.code === 'codex-plugin-ready')
          return {
            outcomes: [
              {
                code: 'codex-plugin-unchanged',
                message: `${requirement.spec} shared prerequisite`,
                status: 'unchanged' as const,
              },
            ],
          };
        if (state.code === 'codex-plugin-missing') {
          // trusted official npm source needs no force flag; an existing install remains protected.
          await command(context, 'install', [
            'plugins',
            'install',
            `npm:${requirement.spec}`,
            '--pin',
            '--accept-capabilities',
          ]);
        } else {
          await command(context, 'enable', ['plugins', 'enable', 'codex', '--accept-capabilities']);
        }
        const verified = await inspect(context);
        if (verified.finding.code !== 'codex-plugin-ready')
          throw new AgentSystemLifecycleError(
            'codex-plugin',
            'codex-plugin-verification-failed',
            `${verified.finding.message} ${verified.finding.remediation}`,
          );
        return {
          outcomes: [
            {
              code:
                state.code === 'codex-plugin-missing'
                  ? 'codex-plugin-installed'
                  : 'codex-plugin-enabled',
              message: `${requirement.spec} shared prerequisite`,
              status:
                state.code === 'codex-plugin-missing' ? ('created' as const) : ('updated' as const),
            },
          ],
        };
      });
    },
  };
}
