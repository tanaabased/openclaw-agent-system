import { notificationResetDiagnostic } from '../../../agent/notification-reset-diagnostic.ts';
import { automationHash } from '../../../agent/automation-hash.ts';
import type { Readable } from 'node:stream';
import { createClackPrompter } from 'openclaw/plugin-sdk/setup-runtime';
import type OpenClawNotificationReset from '../../../agent/openclaw-notification-reset.ts';
import type AgentManifestService from '../../../manifest/service.ts';
import loadCommandManifest from '../../../cli/load-command-manifest.ts';
import presentCliCommand from '../../../cli/presentation.ts';
import {
  createCliStyles,
  renderCliSummary,
  renderCliTableRows,
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
  fresh?: boolean;
  json: boolean;
  preview?: boolean;
  confirmation?: string;
  listAgents(): Promise<string[]>;
  service: Pick<OpenClawNotificationReset, 'preview' | 'run'>;
  manifestService: Pick<AgentManifestService, 'loadForAgentId' | 'loadForCommandDirectory'>;
  workspaceDir: string;
  output: CliOutput;
  styles?: CliStyles;
  terminalColumns?: number;
  input?: Readable;
  environment?: Readonly<NodeJS.ProcessEnv>;
  prompt?: Pick<ReturnType<typeof createClackPrompter>, 'confirm' | 'multiselect'>;
  sleep?: typeof abortableDelay;
  setExitCode(code: number): void;
}

async function resetNotificationsCommand(options: ResetNotificationsOptions) {
  const styles = options.styles ?? createCliStyles();
  const tableOptions = {
    rowPadding: 0 as const,
    terminalColumns: options.terminalColumns ?? process.stdout.columns,
  };
  if (options.all && options.agents.length) throw new Error('notification-reset-target-conflict');
  const environment = options.environment ?? process.env;
  const unattended =
    options.json ||
    ((options.input ?? process.stdin) as { isTTY?: boolean }).isTTY !== true ||
    [environment.CI, environment.NONINTERACTIVE].some((value) =>
      /^(1|true|yes|on)$/iu.test(value ?? ''),
    );
  if (
    (unattended && !options.yes && !options.preview) ||
    ((options.yes || options.preview) && !options.all && !options.agents.length)
  )
    throw new Error('notification-reset-requires-explicit-target-and-yes');
  const available = [...new Set(await options.listAgents())].sort();
  if (options.agents.some((id) => !available.includes(id)))
    throw new Error('notification-reset-agent-unknown');
  let agents = options.all ? available : [...new Set(options.agents)];
  const prompt = options.prompt ?? createClackPrompter(process.stderr);
  if (!options.yes && !options.preview && !options.all && !options.agents.length) {
    const selected = await prompt.multiselect({
      message: 'reset notifications for which agents?',
      options: available.map((id) => ({ value: id, label: id })),
    });
    agents = available.filter((id) => selected.includes(id));
  }
  if (!agents.length) {
    if (options.json) writeCliJson(options.output, { results: [] });
    else
      writeCliLines(options.output, [
        '',
        ...renderCliSummary(
          [{ label: 'result', style: 'field', value: 'no agents selected' }],
          styles,
          tableOptions,
        ),
        '',
      ]);
    return;
  }
  const targets = [];
  for (const agentId of agents) {
    const loaded = await loadCommandManifest({ ...options, agentId });
    if (!loaded) return;
    let preview = await options.service.preview(
      loaded.manifest,
      loaded.scope.workspaceDir,
      options.purge,
      options.fresh,
    );
    if (preview.continuing && !options.fresh && !options.yes && !options.preview) {
      const resume = await prompt.confirm({
        message: `${agentId}: resume the interrupted reset? choose no to start fresh and recheck retained cleanup targets`,
        initialValue: true,
      });
      if (!resume)
        preview = await options.service.preview(
          loaded.manifest,
          loaded.scope.workspaceDir,
          options.purge,
          true,
        );
    }
    targets.push({ loaded, preview });
  }
  const confirmation = automationHash(
    targets.map(({ preview }) => [preview.agentId, preview.purge, preview.fingerprint]),
  );
  if (
    options.confirmation &&
    options.confirmation !== confirmation &&
    targets.some(({ preview }) => !preview.continuing || preview.restarting)
  )
    throw new Error('notification-reset-preview-changed');
  if (!options.json)
    writeCliLines(options.output, [
      '',
      styles.bold(options.purge ? 'notification reset and purge' : 'notification reset'),
      '',
      ...renderCliSummary(
        [
          {
            label: 'action',
            style: 'action',
            value:
              'pause intake, wait for managed turns, clear routing and feedback state, establish a fresh assignment baseline, replace the intake chat, then restore its prior schedule state',
          },
        ],
        styles,
        tableOptions,
      ),
      ...targets.flatMap(({ preview }) => [
        '',
        ...renderCliSummary(
          [
            { label: 'agent', style: 'target', value: preview.agentId },
            { label: 'workspace', style: 'field', value: preview.workspace },
            ...(preview.fresh || preview.continuing
              ? [
                  {
                    label: 'reset',
                    style: 'field' as const,
                    value: preview.fresh
                      ? 'fresh reset; retain cleanup inventory and unverified actions'
                      : 'finish interrupted reset',
                  },
                ]
              : []),
          ],
          styles,
          tableOptions,
        ),
        ...preview.resources.flatMap((resource) => [
          '',
          ...renderCliSummary(
            [
              {
                label: resource.kind,
                style: 'target',
                value: ['chat', 'coordinator'].includes(resource.kind)
                  ? `***${resource.description.slice(-4)}`
                  : resource.description,
              },
              ...resource.details.map((detail) => ({
                label: 'detail',
                style: 'field' as const,
                value: detail,
              })),
            ],
            styles,
            tableOptions,
          ),
        ]),
      ]),
      '',
    ]);
  if (options.preview) {
    if (options.json)
      writeCliJson(options.output, {
        status: 'confirmation-required',
        confirmation,
        targets: targets.map(({ preview }) => ({
          agentId: preview.agentId,
          workspace: preview.workspace,
          purge: preview.purge,
          continuing: preview.continuing,
          fresh: preview.fresh,
          resources: preview.resources,
        })),
      });
    return;
  }
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
          if (result.warnings?.length)
            writeCliDiagnosticNotices(
              options,
              result.warnings.map((message) => ({ severity: 'warning', message })),
            );
          results.push(result);
          if (result.status !== 'complete') options.setExitCode(1);
          break;
        }
        if (announced !== result.code && !options.json) {
          writeCliLines(options.output, [
            '',
            ...renderCliSummary(
              [
                {
                  label: 'waiting',
                  style: 'notice',
                  value: result.instruction ?? 'waiting for managed turns to finish',
                },
              ],
              styles,
              tableOptions,
            ),
            '',
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
      const diagnostic = notificationResetDiagnostic(error);
      const { code, phase, operation, resource } = diagnostic;
      const details = [
        `agent: ${loaded.manifest.agent.id}`,
        phase && `phase: ${phase}`,
        operation && `operation: ${operation}`,
        resource &&
          `${resource.kind}: ${resource.kind === 'worktree' ? resource.description : `***${resource.description.slice(-4)}`}`,
      ]
        .filter(Boolean)
        .join('; ');
      results.push({ status: 'incomplete', agentId: loaded.manifest.agent.id, ...diagnostic });
      writeCliDiagnosticNotices(options, [
        {
          severity: 'error',
          message: `${code}; ${details}; the recovery record is retained; resolve this failure before rerunning the same reset`,
        },
      ]);
      options.setExitCode(1);
    }
  }
  if (options.json) writeCliJson(options.output, { results });
  else
    writeCliLines(options.output, [
      '',
      ...renderCliTableRows(
        [
          { cells: [{ value: 'agent' }, { value: 'status' }] },
          ...results.map((result) => ({
            cells: [
              { value: result.agentId, style: 'target' as const },
              {
                value: result.status,
                style: result.status === 'complete' ? ('status' as const) : ('error' as const),
              },
            ],
          })),
        ],
        styles,
        tableOptions,
      ),
      '',
    ]);
}

export default presentCliCommand(resetNotificationsCommand);
