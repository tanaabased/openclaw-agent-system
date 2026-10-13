/** native orchestration keeps the prepared prompt out of model transcription. */
export default function codexDispatchHandoff(runtime: {
  nodeExecutable: string;
  entrypoint: string;
  pluginData: string;
}) {
  const argv = [
    runtime.nodeExecutable,
    runtime.entrypoint,
    'dispatch',
    '--plugin-data',
    runtime.pluginData,
  ];
  return `const argv = ${JSON.stringify(argv)};
${String.raw`const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = argv.map(quote).join(' ') + " <<'AGENT_SYSTEM_PREPARE'\n" + JSON.stringify(prepareInput) + '\nAGENT_SYSTEM_PREPARE';
async function prepare(escalated = false) {
  let result = await tools.exec_command({
    cmd: command, max_output_tokens: 32000,
    ...(escalated ? {
      sandbox_permissions: 'require_escalated',
      justification: 'Allow the activated assignment workflow to prepare this native assessment handoff?',
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
    throw new Error('dispatch-preparation-failed; inspect the command result and reconcile before retrying');
  }
  return JSON.parse(output);
}
let prepared = await prepare();
for (let retry = 0; prepared.status === 'busy' && retry < 3; retry++) {
  await new Promise(resolve => setTimeout(resolve, 2000));
  prepared = await prepare();
}
if (prepared.status === 'prepared') {
  text({id: prepared.id, creation: await tools.mcp__codex_app__create_thread(prepared.request)});
}`}`;
}
