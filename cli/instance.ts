import type AssignmentClaimStore from '../agent/assignment-claim-store.ts';
import { operateInstanceIdentity } from '../agent/instance-identity.ts';
import presentCliCommand from './presentation.ts';
import {
  type CliOutput,
  type CliStyles,
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
    setExitCode(code: number): void;
  }) => {
    try {
      if (!options.store) throw new Error('instance-runtime-unavailable');
      const result = await operateInstanceIdentity(options.store, options.action, options.input);
      if (options.json) writeCliJson(options.output, result);
      else
        writeCliLines(options.output, [
          'instanceId' in result
            ? `name: ${result.displayName}; id: ***${result.instanceId.slice(-4)}; ${result.status}`
            : 'installation identity is missing; run install.',
        ]);
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
