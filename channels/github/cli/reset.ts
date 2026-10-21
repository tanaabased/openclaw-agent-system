import type { Readable } from 'node:stream';
import { createClackPrompter } from 'openclaw/plugin-sdk/setup-runtime';
import type OpenClawNotificationReset from '../../../agent/openclaw-notification-reset.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import loadCommandManifest from '../../../cli/load-command-manifest.ts';
import presentCliCommand from '../../../cli/presentation.ts';
import {
  createCliStyles,
  writeCliDiagnosticNotices,
  writeCliJson,
  writeCliLines,
  type CliOutput,
  type CliStyles,
} from '../../../cli/output.ts';
import abortableDelay from '../../../utils/abortable-delay.ts';

export interface ResetNotificationsOptions {
  agents: string[];
  all: boolean;
  yes: boolean;
  purge: boolean;
  json: boolean;
  listAgents(): Promise<string[]>;
  service: Pick<OpenClawNotificationReset, 'preview' | 'run'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  workspaceDir: string;
  output: CliOutput;
  styles?: CliStyles;
  input?: Readable;
  environment?: Readonly<NodeJS.ProcessEnv>;
  prompt?: Pick<ReturnType<typeof createClackPrompter>, 'confirm' | 'multiselect'>;
  sleep?: typeof abortableDelay;
  setExitCode(code: number): void;
}

async function resetNotificationsCommand(options: ResetNotificationsOptions) {
  if (options.all && options.agents.length) throw new Error('notification-reset-target-conflict');
  const environment = options.environment ?? process.env;
  const unattended =
    options.json ||
    ((options.input ?? process.stdin) as { isTTY?: boolean }).isTTY !== true ||
    [environment.CI, environment.NONINTERACTIVE].some((value) =>
      /^(1|true|yes|on)$/iu.test(value ?? ''),
    );
  if ((unattended && !options.yes) || (options.yes && !options.all && !options.agents.length))
    throw new Error('notification-reset-requires-explicit-target-and-yes');
  const available = [...new Set(await options.listAgents())].sort();
  if (options.agents.some((id) => !available.includes(id)))
    throw new Error('notification-reset-agent-unknown');
  let agents = options.all ? available : [...new Set(options.agents)];
  const prompt = options.prompt ?? createClackPrompter(process.stderr);
  if (!options.yes) {
    const selected = await prompt.multiselect({
      message: 'reset notifications for which agents?',
      options: [
        { value: '*', label: 'all agents' },
        ...available.map((id) => ({ value: id, label: id })),
      ],
      initialValues: options.all ? ['*'] : agents,
    });
    agents = selected.includes('*') ? available : selected;
  }
  if (!agents.length) {
    if (options.json) writeCliJson(options.output, { results: [] });
    else writeCliLines(options.output, ['no agents selected']);
    return;
  }
  const styles = options.styles ?? createCliStyles();
  const targets = [];
  for (const agentId of agents) {
    const loaded = await loadCommandManifest({ ...options, agentId });
    if (!loaded) return;
    const preview = await options.service.preview(
      loaded.manifest,
      loaded.scope.workspaceDir,
      options.purge,
    );
    targets.push({ loaded, preview });
  }
  if (!options.json)
    writeCliLines(options.output, [
      '',
      styles.bold(options.purge ? 'notification reset and purge' : 'notification reset'),
      'pause intake, wait for managed turns, clear routing and feedback state, establish a fresh assignment baseline, then restore intake',
      ...targets.flatMap(({ preview }) => [
        `${preview.agentId}: ${preview.workspace}${preview.continuing ? ' (finish interrupted reset)' : ''}`,
        ...preview.resources.flatMap((resource) => [
          `  ${resource.kind}: ${resource.kind === 'chat' ? `***${resource.description.slice(-4)}` : resource.description}`,
          ...resource.details.map((detail) => `    ${detail}`),
        ]),
      ]),
      '',
    ]);
  if (
    !options.yes &&
    !(await prompt.confirm({
      message: options.purge
        ? 'reset notifications and purge these resources?'
        : 'reset notifications for these agents?',
      initialValue: false,
    }))
  )
    return;
  const results = [];
  for (const { loaded, preview: initial } of targets) {
    let preview = initial;
    let announced = '';
    try {
      for (;;) {
        const result = await options.service.run(
          loaded.manifest,
          loaded.scope.workspaceDir,
          preview,
        );
        if (result.status !== 'waiting') {
          results.push(result);
          if (result.status !== 'complete') options.setExitCode(1);
          break;
        }
        if (announced !== result.code && !options.json) {
          writeCliLines(options.output, [
            styles.notice(result.instruction ?? 'waiting for managed turns to finish'),
          ]);
          announced = result.code ?? '';
        }
        await (options.sleep ?? abortableDelay)(2000);
        preview = await options.service.preview(
          loaded.manifest,
          loaded.scope.workspaceDir,
          options.purge,
        );
        if (preview.operationId !== result.operationId)
          throw new Error('notification-reset-operation-changed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = /^notification-reset-[a-z-]+$/u.test(message)
        ? message
        : 'notification-reset-failed';
      results.push({ status: 'incomplete', agentId: loaded.manifest.agent.id, code });
      writeCliDiagnosticNotices(options, [
        {
          severity: 'error',
          message: `${code}: correct the obstacle and rerun the same reset; the recovery record is retained`,
        },
      ]);
      options.setExitCode(1);
    }
  }
  if (options.json) writeCliJson(options.output, { results });
  else
    writeCliLines(
      options.output,
      results.map((result) => `${result.agentId}: ${result.status}`),
    );
}

export default presentCliCommand(resetNotificationsCommand);
