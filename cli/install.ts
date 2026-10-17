import { formatErrorMessage } from 'openclaw/plugin-sdk/error-runtime';

import { manifestNotices, lifecycleWarningNotice } from './diagnostic-notices.ts';
import confirmSessionDispatch from './session-dispatch-consent.ts';
import presentCliCommand from './presentation.ts';
import confirmSetupInstall, { type SetupConsentOptions } from './setup-consent.ts';
import {
  AgentInstallError,
  type default as AgentInstallService,
} from '../agent/install-service.ts';
import type AgentManifestService from '../manifest/service.ts';
import {
  type CliOutput,
  type CliStyles,
  type CliNotice,
  writeCliDiagnosticNotices,
  writeCliJson,
  writeCliLifecycleTable,
} from './output.ts';
import { lifecycleTableLines } from '../core/lifecycle-presentation.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleWarning,
} from '../core/lifecycle-registry.ts';
import { selectedSetupPhases } from '../agent/install-options.ts';

export interface InstallAgentSystemOptions extends Pick<
  SetupConsentOptions,
  | 'yes'
  | 'nonInteractive'
  | 'skipSetup'
  | 'skipSetupHost'
  | 'skipSetupAgent'
  | 'environment'
  | 'input'
  | 'prompt'
> {
  installService: Pick<AgentInstallService, 'install'> &
    Partial<Pick<AgentInstallService, 'sessionDispatchPlan'>>;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForCommandDirectory'>;
  output: CliOutput;
  rebuildCodexPath?: boolean;
  setExitCode(code: number): void;
  styles?: CliStyles;
  terminalColumns?: number;
  workspaceDir: string;
}

function installNotices(
  warnings: readonly AgentSystemLifecycleWarning[],
  json: boolean,
): CliNotice[] {
  return warnings.flatMap((warning) => {
    const { code } = warning;
    const notice = lifecycleWarningNotice(warning);
    if (json) return [notice];
    if (code === 'collaboration-session-access') return [{ ...notice, severity: 'notice' }];
    if (code === 'github-operator-loaded-access-unverified') {
      return [
        {
          severity: 'notice',
          message:
            'operator recognition is channel-wide openclaw access, not repository-scoped access; independent tool policy still applies.',
        },
        notice,
      ];
    }
    return [notice];
  });
}

// selected setup skips remain in results and tables, not stderr.
function isSelectedSetupSkip(
  warning: AgentSystemLifecycleWarning,
  options: InstallAgentSystemOptions,
): boolean {
  if (warning.component !== 'setup' || warning.stepId) return false;
  const selection = selectedSetupPhases(options);
  return (
    (warning.code === 'setup-skipped' && selection.skipSetupHost && selection.skipSetupAgent) ||
    (warning.code === 'setup-host-skipped' &&
      selection.skipSetupHost &&
      !selection.skipSetupAgent) ||
    (warning.code === 'setup-agent-skipped' && selection.skipSetupAgent && !selection.skipSetupHost)
  );
}

/** Reconcile every configured lifecycle component for the current workspace manifest. */
async function installAgentSystem(options: InstallAgentSystemOptions): Promise<void> {
  const result = await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  if (result.status !== 'loaded') {
    writeCliDiagnosticNotices(options, manifestNotices(result));
    options.setExitCode(1);
    return;
  }

  writeCliDiagnosticNotices(options, manifestNotices(result));
  let sessionDispatchConsent = false;
  try {
    const plan = await options.installService.sessionDispatchPlan?.(result.manifest);
    if (plan?.enrollmentRequired) {
      sessionDispatchConsent = await confirmSessionDispatch(
        { ...options, runtime: 'openclaw' },
        plan.consumers,
      );
      if (!sessionDispatchConsent) {
        writeCliDiagnosticNotices(options, [
          {
            severity: 'error',
            message:
              'session dispatch enrollment was not approved; use interactive install or --yes. code=session-dispatch-approval-required',
          },
        ]);
        if (options.json)
          writeCliJson(options.output, {
            status: 'blocked',
            code: 'session-dispatch-approval-required',
          });
        options.setExitCode(1);
        return;
      }
    }
  } catch {
    writeCliDiagnosticNotices(options, [
      {
        severity: 'error',
        message:
          'session dispatch enrollment could not be inspected; no installation changes were made. code=session-dispatch-inspection-failed',
      },
    ]);
    if (options.json)
      writeCliJson(options.output, {
        status: 'blocked',
        code: 'session-dispatch-inspection-failed',
      });
    options.setExitCode(1);
    return;
  }
  if (
    !(await confirmSetupInstall({
      ...options,
      runtime: 'openclaw',
      setup: result.manifest.setup,
      setupHost: result.manifest.setupHost,
      workspaceDir: result.scope.workspaceDir,
    }))
  ) {
    const message = 'install: installation cancelled before making changes. code=setup-declined';
    writeCliDiagnosticNotices(options, [{ severity: 'notice', message }]);
    options.setExitCode(1);
    return;
  }
  try {
    const selection = selectedSetupPhases(options);
    const installed = await options.installService.install({
      runtime: 'openclaw',
      ...(sessionDispatchConsent
        ? {
            sessionDispatchConsent: true,
            async assertCurrent() {
              const current = await options.manifestService.loadForCommandDirectory(
                options.workspaceDir,
                'cli',
              );
              if (
                current.status !== 'loaded' ||
                current.digest !== result.digest ||
                current.path !== result.path ||
                current.scope.workspaceDir !== result.scope.workspaceDir
              )
                throw new AgentInstallError(
                  'The manifest changed after session dispatch consent; rerun Install.',
                  'session-dispatch-plan-changed',
                );
            },
          }
        : {}),
      manifest: result.manifest,
      workspaceDir: result.scope.workspaceDir,
      ...(selection.skipSetupHost ? { skipSetupHost: true } : {}),
      ...(selection.skipSetupAgent ? { skipSetupAgent: true } : {}),
      ...(options.rebuildCodexPath ? { rebuildCodexPath: true } : {}),
    });
    if (options.json) writeCliJson(options.output, installed);
    else {
      writeCliLifecycleTable(
        options.output,
        lifecycleTableLines(installed.outcomes),
        installed.workspaceDir,
        options.styles,
        options.terminalColumns,
      );
    }
    writeCliDiagnosticNotices(
      options,
      installNotices(
        installed.warnings.filter((warning) => !isSelectedSetupSkip(warning, options)),
        options.json,
      ),
    );
  } catch (error) {
    const failure = error instanceof AgentSystemLifecycleError ? error : undefined;
    const blocked = {
      component:
        failure?.component ?? (error instanceof AgentInstallError ? 'credentials' : 'install'),
      code: failure?.code ?? (error instanceof AgentInstallError ? error.code : 'install-failed'),
      message: error instanceof Error ? error.message : 'Installation failed.',
      ...(failure?.stepId ? { stepId: failure.stepId } : {}),
    };
    const unattempted = failure?.progress?.unattempted ?? [{ component: 'lifecycle' }];
    const outcomes = failure?.progress?.outcomes ?? [];
    const warnings = failure?.progress?.warnings ?? [];
    const hint =
      selectedSetupPhases(options).skipSetupHost && blocked.code?.endsWith('tool_unavailable')
        ? 'Host setup was skipped. If it installs the missing executable, rerun without --skip-setup-host or --skip-setup.'
        : undefined;
    const recovery =
      outcomes.length > 0
        ? 'Earlier completed changes remain applied. The blocking component may also have partial effects; rerun install after fixing it.'
        : 'The blocking component may have partial effects; rerun install after fixing it.';
    if (options.json) {
      writeCliJson(options.output, {
        status: 'failed',
        agentId: result.manifest.agent.id,
        workspaceDir: result.scope.workspaceDir,
        outcomes,
        warnings,
        blocked,
        unattempted,
        earlierChangesRemainApplied: outcomes.length > 0,
        recovery,
        ...(hint ? { hint } : {}),
      });
    } else if (outcomes.length > 0) {
      writeCliLifecycleTable(
        options.output,
        lifecycleTableLines(outcomes),
        result.scope.workspaceDir,
        options.styles,
        options.terminalColumns,
      );
    }
    const humanRecovery =
      outcomes.length > 0
        ? 'earlier completed changes remain applied. the blocking component may also have partial effects; rerun install after fixing it.'
        : 'the blocking component may have partial effects; rerun install after fixing it.';
    const guidance = [
      `${options.json ? 'Unattempted' : 'unattempted'} work: ${unattempted.map(({ component, stepId }) => (stepId ? `${component}/${stepId}` : component)).join(', ') || 'none'}.`,
      ...(outcomes.length > 0
        ? []
        : [
            options.json
              ? 'No completed component outcomes were reported.'
              : 'no completed component outcomes were reported.',
          ]),
      options.json ? recovery : humanRecovery,
      ...(hint
        ? [
            options.json
              ? hint
              : 'host setup was skipped. if it installs the missing executable, rerun without --skip-setup-host or --skip-setup.',
          ]
        : []),
    ];
    writeCliDiagnosticNotices(options, [
      ...installNotices(warnings, options.json),
      {
        severity: 'error',
        code: blocked.code,
        component: blocked.component,
        stepId: blocked.stepId,
        message: formatErrorMessage(error),
        details: guidance.slice(0, outcomes.length > 0 ? 1 : 2),
        remediation: guidance.slice(outcomes.length > 0 ? 1 : 2),
      },
    ]);
    options.setExitCode(1);
  }
}

export default presentCliCommand(installAgentSystem);
