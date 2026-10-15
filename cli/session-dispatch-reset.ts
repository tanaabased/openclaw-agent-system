import type SessionDispatchCredential from '../credentials/session-dispatch.ts';
import presentCliCommand from './presentation.ts';
import { writeCliDiagnosticNotices, writeCliJson, type CliOutput } from './output.ts';

/** clear only the exact enrollment whose gateway authorization has already been removed. */
export default presentCliCommand(async function resetSessionDispatch(options: {
  deviceId: string;
  service: Pick<SessionDispatchCredential, 'reset'>;
  output: CliOutput;
  setExitCode(code: number): void;
}) {
  try {
    writeCliJson(options.output, await options.service.reset(options.deviceId));
  } catch (error) {
    writeCliDiagnosticNotices(options, [
      {
        severity: 'error',
        message: error instanceof Error ? error.message : 'session dispatch reset failed.',
      },
    ]);
    options.setExitCode(1);
  }
});
