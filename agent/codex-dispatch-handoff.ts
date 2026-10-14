/** native orchestration keeps the prepared prompt out of model transcription. */
export default function codexDispatchHandoff(
  runtime: {
    nodeExecutable: string;
    entrypoint: string;
    pluginData: string;
  },
  route: 'dispatch' | 'continuation' = 'dispatch',
) {
  const argv = [
    runtime.nodeExecutable,
    runtime.entrypoint,
    route,
    '--plugin-data',
    runtime.pluginData,
  ];
  const key = JSON.stringify(`agent-system:continuation:${runtime.pluginData}`);
  return `${route === 'continuation' ? `store(${key}, null);\n` : ''}const argv = ${JSON.stringify(argv)};
${String.raw`const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = argv.map(quote).join(' ') + " <<'AGENT_SYSTEM_PREPARE'\n" + JSON.stringify(prepareInput) + '\nAGENT_SYSTEM_PREPARE';
async function prepare(escalated = false) {
  let result = await tools.exec_command({
    cmd: command, max_output_tokens: 32000,
    ...(escalated ? {
      sandbox_permissions: 'require_escalated',
      justification: 'Allow the activated assignment workflow to prepare this native issue handoff?',
      prefix_rule: argv
    } : {})
  });
  let output = result.output;
  while (result.session_id !== undefined) {
    result = await tools.write_stdin({session_id: result.session_id, chars: '', max_output_tokens: 32000});
    output += result.output;
  }
  text({...result, output});
  if (result.exit_code !== 0) {
    if (!escalated && /codex-host-access-required|EPERM|EACCES/u.test(output)) return prepare(true);
    throw new Error('native-handoff-preparation-failed; inspect the command result and reconcile before retrying');
  }
  return JSON.parse(output);
}
let prepared = await prepare();
for (let retry = 0; prepared.status === 'busy' && retry < 3; retry++) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  prepared = await prepare();
}
if (prepared.status === 'prepared') {
  HANDOFF
}`.replace(
  'HANDOFF',
  route === 'dispatch'
    ? 'text({id: prepared.id, native: await tools.mcp__codex_app__create_thread(prepared.request)});'
    : `store(${key}, prepared);`,
)}`;
}

/** consume the exact request once, in a separate execution from host-access preparation. */
export function codexContinuationSend(pluginData: string) {
  const key = JSON.stringify(`agent-system:continuation:${pluginData}`);
  return `const prepared = load(${key});
if (!prepared || prepared.status !== 'prepared') throw new Error('continuation-prepared-request-unavailable');
store(${key}, null);
text({id: prepared.id, native: await tools.mcp__codex_app__send_message_to_thread(prepared.request)});`;
}
