import { Command } from 'commander';

import AgentCommandAuthority from '../agent/command-authority.ts';
import registerAgentSystemCli from '../cli/register.ts';

// A fake OpenClaw host keeps the subprocess on real CLI/binding code without loading a Gateway.
const unavailable = async (): Promise<never> => {
  throw new Error('unexpected child-side service execution');
};
const authority = new AgentCommandAuthority({
  rootDir: process.argv[2],
  manifestService: { loadForAgentId: unavailable },
});
const program = new Command().name('openclaw').exitOverride();
registerAgentSystemCli(program, {
  commandAuthority: authority,
  credentialInput: { read: unavailable },
  credentialManager: { set: unavailable, unset: unavailable, validate: unavailable },
  doctorService: { inspect: unavailable },
  environmentService: { loadForAgentId: unavailable, loadForCommandDirectory: unavailable },
  installService: { install: unavailable },
  input: process.stdin,
  manifestService: { loadForAgentId: unavailable, loadForCommandDirectory: unavailable },
  notificationMonitorService: { runOnce: unavailable },
  notificationStatusService: { inspect: unavailable, wait: unavailable },
  output: {
    writeStderr: (value) => process.stderr.write(value),
    writeStdout: (value) => process.stdout.write(value),
  },
  toolRegistry: { invoke: unavailable },
  toolRuntime: {} as never,
});
await program.parseAsync(process.argv.slice(3), { from: 'user' });
