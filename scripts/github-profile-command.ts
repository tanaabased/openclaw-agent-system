import { runCommandWithTimeout } from 'openclaw/plugin-sdk/process-runtime';
import { readFileSync } from 'node:fs';

import createToolCliRunner from '../api/cli-runner.ts';

// ci supplies the already-resolved executable before installing its profiling shim.
const [executable, ...argv] = process.argv.slice(2);
if (process.env.GITHUB_ACTIONS !== 'true' || !executable?.startsWith('/')) {
  throw new Error('github profiling requires a ci-owned absolute executable');
}
const account = Object.keys(process.env).find(
  (name) =>
    name.startsWith('GH_TOKEN_') && process.env[name] && process.env[name] === process.env.GH_TOKEN,
);
const run = createToolCliRunner(
  runCommandWithTimeout,
  process.env.AGENT_SYSTEM_GITHUB_PROFILE_DIR,
  () => process.stderr.write('github-request-profile-unavailable\n'),
);
const result = await run({
  executable,
  argv,
  cwd: process.cwd(),
  environment: process.env,
  githubProfileContext: { account, agentId: 'fixture', source: 'fixture' },
  maxOutputBytes: 1024 * 1024,
  timeoutMs: 120000,
  stdin: readFileSync(0, 'utf8'),
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.exitCode ?? 1;
