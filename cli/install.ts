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
  writeCliDiagnostics,
  writeCliJson,
  writeCliLifecycleTable,
} from './output.ts';
import { lifecycleTableLines } from '../core/lifecycle-presentation.ts';
import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';
import { selectedSetupPhases } from '../agent/install-options.ts';
import {
  formatDiagnostic,
  formatErrorDiagnostic,
  formatManifestDiagnostics,
  formatManifestFailure,
} from '../core/logger.ts';

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
  installService: Pick<AgentInstallService, 'install'>;
  json: boolean;
  manifestService: Pick<AgentManifestService, 'loadForCommandDirectory'>;
  output: CliOutput;
  rebuildCodexPath?: boolean;
  setExitCode(code: number): void;
  styles?: CliStyles;
  terminalColumns?: number;
  workspaceDir: string;
}

function installNotices(warnings: ReadonlyArray<{ code: string; message: string }>): CliNotice[] {
  return warnings.flatMap(({ code, message }) => {
    if (code === 'collaboration-session-access') return [{ severity: 'notice', message }];
    if (code === 'github-operator-loaded-access-unverified') {
      return [
        {
          severity: 'notice',
          message:
            'operator recognition is channel-wide openclaw access, not repository-scoped access; independent tool policy still applies.',
        },
        { severity: 'warning', message },
      ];
    }
    return [{ severity: 'warning', message }];
  });
}

function isSetupSkipWarning(code: string): boolean {
  return ['setup-skipped', 'setup-host-skipped', 'setup-agent-skipped'].includes(code);
}

/** Reconcile every configured lifecycle component for the current workspace manifest. */
async function installAgentSystem(options: InstallAgentSystemOptions): Promise<void> {
  const result = await options.manifestService.loadForCommandDirectory(options.workspaceDir, 'cli');
  if (result.status !== 'loaded') {
    writeCliDiagnosticNotices(
      options,
      formatManifestFailure(result).map(({ level, message }) => ({ severity: level, message })),
    );
    options.setExitCode(1);
    return;
  }

  writeCliDiagnosticNotices(
    options,
    formatManifestDiagnostics(result).map(({ level, message }) => ({ severity: level, message })),
  );
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
      manifest: result.manifest,
      workspaceDir: result.scope.workspaceDir,
      ...(selection.skipSetupHost ? { skipSetupHost: true } : {}),
      ...(selection.skipSetupAgent ? { skipSetupAgent: true } : {}),
      ...(options.rebuildCodexPath ? { rebuildCodexPath: true } : {}),
    });
    if (options.json) {
      writeCliDiagnostics(
        options.output,
        installed.warnings
          .filter(({ code }) => !isSetupSkipWarning(code))
          .map((warning) =>
            formatDiagnostic({
              code: warning.code,
              component: warning.component,
              message: warning.message,
            }),
          ),
      );
      writeCliJson(options.output, installed);
    } else {
      writeCliLifecycleTable(
        options.output,
        lifecycleTableLines(installed.outcomes),
        installed.workspaceDir,
        options.styles,
        options.terminalColumns,
      );
      writeCliDiagnosticNotices(
        options,
        installNotices(installed.warnings.filter(({ code }) => !isSetupSkipWarning(code))),
      );
    }
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
    const errorMessage = formatErrorDiagnostic(blocked.component, error, blocked.code);
    if (options.json) {
      writeCliDiagnostics(options.output, [
        ...warnings.map((warning) => formatDiagnostic(warning)),
        errorMessage,
        ...guidance,
      ]);
    } else {
      writeCliDiagnosticNotices(options, [
        ...installNotices(
          warnings.map((warning) => ({ ...warning, message: formatDiagnostic(warning) })),
        ),
        { severity: 'error', message: errorMessage },
        { severity: 'notice', message: guidance.join('\n') },
      ]);
    }
    options.setExitCode(1);
  }
}

export default presentCliCommand(installAgentSystem);
