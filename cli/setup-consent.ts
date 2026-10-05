import type { Readable } from 'node:stream';

import { ConfirmPrompt } from '@clack/core';
import {
  settings,
  S_BAR,
  S_BAR_END,
  S_RADIO_ACTIVE,
  S_RADIO_INACTIVE,
  S_STEP_ACTIVE,
  S_STEP_CANCEL,
  S_STEP_SUBMIT,
} from '@clack/prompts';
import { wrapAnsi } from 'fast-wrap-ansi';

import type {
  AgentSetupCommand,
  AgentSetupConfiguration,
  AgentSetupRuntime,
} from '../manifest/setup-schema.ts';
import setupStepApplies from '../agent/setup-runtime.ts';
import { selectedSetupPhases, type InstallSetupOptions } from '../agent/install-options.ts';
import { createCliStyles, type CliOutput, type CliStyles } from './output.ts';

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
  styles?: CliStyles;
  terminalColumns?: number;
  prompt?: (options: ConstructorParameters<typeof ConfirmPrompt>[0]) => Promise<boolean | symbol>;
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

  const styles = options.styles ?? createCliStyles(environment);
  const terminalColumns = options.terminalColumns ?? process.stderr.columns ?? 80;
  const columns =
    Number.isFinite(terminalColumns) && terminalColumns >= 1 ? Math.floor(terminalColumns) : 80;
  const wrap = (text: string, indentation = 0) => {
    const indent = ' '.repeat(Math.min(indentation, columns - 1));
    return wrapAnsi(text, columns - indent.length, { hard: true, trim: false })
      .split('\n')
      .map((line) => `${indent}${line}`)
      .join('\n');
  };
  const workspace = JSON.stringify(options.workspaceDir);
  const lines = [
    wrap(
      `${styles.action(S_STEP_SUBMIT)} Install workspace ${styles.field('"')}${styles.bold(workspace.slice(1, -1))}${styles.field('"')} with these setup steps:`,
    ),
    ...applicable.flatMap(({ step, stage }) => [
      wrap(
        `${stage === 'setup-host' ? styles.action(`${stage}:`) : styles.accent(`${stage}:`)} ${styles.bold(step.id)}`,
        2,
      ),
      ...(step.check
        ? [wrap(`check ${styles.field(`(${describeCommand(step.check)})`)}`, 4)]
        : [wrap(`check${styles.field(': not declared')}`, 4)]),
      wrap(`apply ${styles.field(`(${describeCommand(step.apply)})`)}`, 4),
    ]),
  ];
  options.output.writeStderr(`${lines.join('\n')}\n`);
  try {
    const answer = await (options.prompt ?? ((prompt) => new ConfirmPrompt(prompt).prompt()))({
      active: 'Yes',
      inactive: 'No',
      initialValue: false,
      input,
      output: process.stderr,
      render() {
        const guide = settings.withGuide;
        const finished = this.state === 'submit' || this.state === 'cancel';
        const marker =
          this.state === 'cancel' ? S_STEP_CANCEL : finished ? S_STEP_SUBMIT : S_STEP_ACTIVE;
        const heading = wrap(
          `${styles.action(marker)}  ${styles.bold('Continue with installation?')}`,
        );
        const prefix = guide ? `${styles.field(S_BAR)}  ` : '';
        const selected = this.value ? 'Yes' : 'No';
        if (finished) return `${heading}\n${prefix}${styles.field(selected)}`;
        const yes = this.value
          ? `${styles.action(S_RADIO_ACTIVE)} Yes`
          : styles.field(`${S_RADIO_INACTIVE} Yes`);
        const no = this.value
          ? styles.field(`${S_RADIO_INACTIVE} No`)
          : `${styles.action(S_RADIO_ACTIVE)} No`;
        return `${guide ? `${styles.field(S_BAR)}\n` : ''}${heading}\n${wrap(`${guide ? `${styles.action(S_BAR)}  ` : ''}${yes} ${styles.field('/')} ${no}`)}\n${guide ? styles.action(S_BAR_END) : ''}\n`;
      },
    });
    return answer === true;
  } catch {
    return false;
  }
}
