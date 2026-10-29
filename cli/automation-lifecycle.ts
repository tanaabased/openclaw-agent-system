import type { AutomationLifecycleCommandScope } from '../agent/automation-lifecycle-authority.ts';
import type { AgentBoundCommand, AgentBoundCommandResult } from '../agent/command-authority.ts';
import type AgentDoctorService from '../agent/doctor-service.ts';
import type AgentInstallService from '../agent/install-service.ts';
import type AgentManifestService from '../manifest/service.ts';
import AgentSystemToolError from '../api/error.ts';
import doctorAgentSystem from './doctor.ts';
import installAgentSystem from './install.ts';

/** Execute in the admitting owner; descendants receive neither operator transport nor target selectors. */
export default async function automationLifecycleCommand(
  command: AgentBoundCommand,
  scope: AutomationLifecycleCommandScope,
  signal: AbortSignal,
  dependencies: {
    manifestService: Pick<AgentManifestService, 'withSnapshot'>;
    doctorService: Pick<AgentDoctorService, 'inspect'>;
    installService: Pick<AgentInstallService, 'install'>;
  },
): Promise<AgentBoundCommandResult> {
  const [operation, ...flags] = command.argv;
  const installFlags: Record<string, string> = {
    '--yes': 'yes',
    '--non-interactive': 'nonInteractive',
    '--json': 'json',
    '--skip-setup': 'skipSetup',
    '--skip-setup-host': 'skipSetupHost',
    '--skip-setup-agent': 'skipSetupAgent',
    '--rebuild-codex-path': 'rebuildCodexPath',
    '--manual-session-dispatch': 'manualSessionDispatch',
  };
  if (
    command.command !== 'lifecycle' ||
    command.stdin !== undefined ||
    !['install', 'doctor', 'status'].includes(operation ?? '') ||
    flags.some((flag) =>
      operation === 'install' ? !Object.hasOwn(installFlags, flag) : flag !== '--json',
    )
  )
    throw new AgentSystemToolError(
      'approval_denied',
      'This automation lifecycle command is not supported.',
    );
  const selected = Object.fromEntries(flags.map((flag) => [installFlags[flag] ?? 'json', true]));
  const assertCurrent = async () => {
    signal.throwIfAborted();
    scope.assertActive();
    await scope.assertCurrent();
    signal.throwIfAborted();
    scope.assertActive();
  };
  const assertEnrollmentCurrent = () => {
    signal.throwIfAborted();
    scope.assertActive();
  };
  await assertCurrent();
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  const loaded = structuredClone(scope.loaded);
  const manifestService = {
    async loadForAgentId() {
      await assertCurrent();
      return structuredClone(loaded);
    },
    async loadForCommandDirectory() {
      await assertCurrent();
      return structuredClone(loaded);
    },
  };
  const common = {
    json: selected.json === true,
    manifestService,
    workspaceDir: loaded.scope.workspaceDir,
    output: {
      writeStdout(value: string) {
        stdout += value;
      },
      writeStderr(value: string) {
        stderr += value;
      },
    },
    setExitCode(code: number) {
      exitCode = code;
    },
  };
  await dependencies.manifestService.withSnapshot(loaded, signal, async () => {
    if (operation === 'install')
      await installAgentSystem({
        ...common,
        ...selected,
        yes: true,
        nonInteractive: true,
        installService: {
          async install(input) {
            await assertCurrent();
            return dependencies.installService.install({
              ...input,
              signal,
              assertCurrent,
              sessionDispatchConsent: true,
              assertEnrollmentCurrent,
            });
          },
        },
      });
    else
      await doctorAgentSystem({
        ...common,
        doctorService: {
          async inspect(input) {
            await assertCurrent();
            return dependencies.doctorService.inspect({ ...input, signal, assertCurrent });
          },
        },
      });
  });
  return { exitCode, stdout, stderr };
}
