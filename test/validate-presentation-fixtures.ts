import validateAgentSystem from '../cli/validate.ts';
import { createCliStyles } from '../cli/output.ts';
import type { AgentManifestLoadResult } from '../manifest/service.ts';

// illustrative data only; previews call the real command with fixture services.
export async function captureValidatePreview(
  result: AgentManifestLoadResult,
  agentId = 'Agent-Mixed',
) {
  const events: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
  let exitCode = 0;
  await validateAgentSystem({
    agentId,
    json: false,
    manifestService: {
      async loadForAgentId() { return result; },
      async loadForCommandDirectory() { return result; },
    },
    output: {
      writeStdout: (text) => events.push({ stream: 'stdout', text }),
      writeStderr: (text) => events.push({ stream: 'stderr', text }),
    },
    setExitCode: (code) => { exitCode = code; },
    styles: createCliStyles({ NO_COLOR: '1' }),
    terminalColumns: 52,
    workspaceDir: '/Workspace/Agent-With-A-Very-Long-Path',
  });
  return { events, exitCode };
}
