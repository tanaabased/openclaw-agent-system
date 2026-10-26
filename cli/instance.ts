import type AssignmentClaimStore from '../agent/assignment-claim-store.ts';
import { operateInstanceIdentity } from '../agent/instance-identity.ts';
import presentCliCommand from './presentation.ts';
import {
  type CliOutput,
  type CliStyles,
  renderCliSummary,
  writeCliError,
  writeCliJson,
  writeCliLines,
} from './output.ts';

export default presentCliCommand(
  async (options: {
    store?: AssignmentClaimStore;
    action: string;
    input: Record<string, unknown>;
    json: boolean;
    output: CliOutput;
    styles?: CliStyles;
    terminalColumns?: number;
    setExitCode(code: number): void;
  }) => {
    try {
      if (!options.store) throw new Error('instance-runtime-unavailable');
      const result = await operateInstanceIdentity(options.store, options.action, options.input);
      if (options.json) writeCliJson(options.output, result);
      else {
        writeCliLines(options.output, [
          '',
          ...renderCliSummary(
            [
              {
                label: 'status',
                style: 'field',
                valueStyle:
                  result.status === 'missing'
                    ? 'warning'
                    : result.status === 'ready'
                      ? 'status'
                      : 'action',
                value: result.status,
              },
              ...('instanceId' in result
                ? [
                    { label: 'name', style: 'target' as const, value: result.displayName },
                    {
                      label: 'id',
                      style: 'field' as const,
                      value: `***${result.instanceId.slice(-4)}`,
                    },
                  ]
                : []),
            ],
            options.styles,
            { rowPadding: 0, terminalColumns: options.terminalColumns ?? process.stdout.columns },
          ),
          '',
        ]);
        if (result.status === 'missing')
          writeCliError(options.output, 'installation identity is missing; run install.', options);
      }
      if (result.status === 'missing') options.setExitCode(1);
    } catch (error) {
      writeCliError(
        options.output,
        error instanceof Error ? error.message : 'instance-operation-failed',
        { styles: options.styles, json: options.json },
      );
      options.setExitCode(1);
    }
  },
);
