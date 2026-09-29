import type { Readable } from 'node:stream';

import { confirm } from '@clack/prompts';

import type {
  AgentSetupCommand,
  AgentSetupConfiguration,
  AgentSetupRuntime,
} from '../manifest/setup-schema.ts';
import setupStepApplies from '../agent/setup-runtime.ts';
import { selectedSetupPhases, type InstallSetupOptions } from '../agent/install-options.ts';
import type { CliOutput } from './output.ts';

export interface SetupConsentOptions extends InstallSetupOptions {
  runtime: AgentSetupRuntime;
  setup?: AgentSetupConfiguration;
  setupHost?: AgentSetupConfiguration;
  workspaceDir: string;
  yes?: boolean;
  nonInteractive?: boolean;
  environment?: Readonly<NodeJS.ProcessEnv>;
  input?: Readable;
  output: CliOutput;
  prompt?: () => Promise<boolean | symbol>;
}

function enabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function describeCommand(command: AgentSetupCommand): string {
  return command.kind === 'shell'
    ? `${command.shell}, ${command.timeoutSeconds}s: ${JSON.stringify(command.script)}`
    : `argv, ${command.timeoutSeconds}s: ${JSON.stringify([command.executable, ...command.args])}`;
}

/** Ask before any install mutation; only this deliberate preview includes command text. */
export default async function confirmSetupInstall(options: SetupConsentOptions): Promise<boolean> {
  if (!options.setup && !options.setupHost) return true;
  const { skipSetupHost, skipSetupAgent } = selectedSetupPhases(options);
  if (skipSetupHost && skipSetupAgent) {
    options.output.writeStderr(
      'Warning: setup was skipped; no setup checks or applies will run.\n',
    );
    return true;
  }
  if (skipSetupHost && options.setupHost)
    options.output.writeStderr(
      'Warning: host setup was skipped; no host setup checks or applies will run.\n',
    );
  if (skipSetupAgent && options.setup)
    options.output.writeStderr(
      'Warning: agent setup was skipped; no agent setup checks or applies will run.\n',
    );
  const applicable = [
    ...(!skipSetupHost ? (options.setupHost?.steps ?? []) : []).map((step) => ({
      step,
      stage: 'setup-host',
    })),
    ...(!skipSetupAgent ? (options.setup?.steps ?? []) : []).map((step) => ({
      step,
      stage: 'setup-agent',
    })),
  ].filter(({ step }) => setupStepApplies(step, options.runtime));
  if (applicable.length === 0) return true;
  const environment = options.environment ?? process.env;
  const input = options.input ?? process.stdin;
  if (
    options.yes ||
    options.nonInteractive ||
    enabled(environment.CI) ||
    enabled(environment.NONINTERACTIVE) ||
    (input as Readable & { isTTY?: boolean }).isTTY !== true
  )
    return true;

  const lines = [
    `Install workspace ${JSON.stringify(options.workspaceDir)} with these setup steps:`,
    ...applicable.flatMap(({ step, stage }) => [
      `  ${stage}: ${step.id}`,
      ...(step.check
        ? [`    check (${describeCommand(step.check)})`]
        : ['    check: not declared']),
      `    apply (${describeCommand(step.apply)})`,
    ]),
  ];
  options.output.writeStderr(`${lines.join('\n')}\n`);
  try {
    const answer = await (
      options.prompt ??
      (() =>
        confirm({
          message: 'Continue with installation?',
          initialValue: false,
          input,
          output: process.stderr,
        }))
    )();
    return answer === true;
  } catch {
    return false;
  }
}
