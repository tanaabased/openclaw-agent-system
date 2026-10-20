interface CodexRuntimeIdentity {
  nodeExecutable: string;
  entrypoint: string;
  pluginData: string;
}

/** scheduled transport retains exact routing evidence and never performs a native handoff. */
export default function codexDispatchHandoff(runtime: CodexRuntimeIdentity) {
  return `const runtime = ${JSON.stringify(runtime)};
${String.raw`const actions = {
  intake: ['scan', 'failure-response'],
  dispatch: ['next', 'prepare', 'reconcile', 'report'],
  continuation: ['next', 'reconcile'],
  feedback: ['reconcile']
};
if (!actions[runtimeRoute]?.includes(runtimeInput.action)) throw new Error('scheduled-runtime-action-unsupported');
const key = 'agent-system:' + runtimeRoute + ':' + runtime.pluginData;
const retained = load(key);
store(key, null);
let input = runtimeInput;
if (runtimeRoute === 'dispatch' && input.action === 'prepare') {
  if (!retained || retained.status !== 'routing-required' || !retained.id || !retained.digest) throw new Error('dispatch-routing-evidence-unavailable');
  if (Object.keys(input).some(key => !['action', 'title', 'assessment', 'fallback'].includes(key))) throw new Error('dispatch-routing-input-invalid');
  input = {...input, id: retained.id, digest: retained.digest};
}
const argv = [runtime.nodeExecutable, runtime.entrypoint, runtimeRoute];
argv.push(input.action);
argv.push('--plugin-data', runtime.pluginData);
const request = {...input};
if (runtimeRoute === 'intake') delete request.action;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = argv.map(quote).join(' ') + " <<'AGENT_SYSTEM_INPUT'\n" + JSON.stringify(request) + '\nAGENT_SYSTEM_INPUT';
let escalated = false;
let busyRetries = 0;
while (true) {
  let result = await tools.exec_command({
    cmd: command, max_output_tokens: 32000,
    ...(escalated ? {
      sandbox_permissions: 'require_escalated',
      justification: 'Allow ' + runtimeRoute + ':' + input.action + ' for the operator-activated recurring assignment workflow? This exact command checks workflow evidence, prepares configured repositories when required, and updates private tracking state; it does not create chats, send turns, implement task code, or publish to GitHub. Eligible assignments are selected by the activated manifest policy. Current operator restrictions and native approval decisions still apply.',
      prefix_rule: argv
    } : {})
  });
  let output = result.output;
  while (result.session_id !== undefined) {
    result = await tools.write_stdin({session_id: result.session_id, chars: '', max_output_tokens: 32000});
    output += result.output;
  }
  text({...result, output});
  let response;
  try { response = JSON.parse(output); } catch { /* raw host-access failures may not be json */ }
  const accessRequired = response?.code === 'codex-host-access-required' || /^(?:EPERM|EACCES)\b/u.test(output.trim());
  if (result.exit_code !== 0 && accessRequired && !escalated) {
    escalated = true;
    continue;
  }
  const busy = response?.status === 'busy' || response?.code === 'private-state-file-lock-busy';
  if (busy && busyRetries < 3) {
    busyRetries++;
    await new Promise(resolve => setTimeout(resolve, 2000));
    continue;
  }
  if (busy) break;
  if (result.exit_code !== 0 || !response) throw new Error('native-handoff-preparation-failed; inspect the command result and reconcile before retrying');
  store(key, response);
  break;
}`}`;
}

/** consume the exact request once, separately from host-access preparation. */
export function codexNativeHandoff(pluginData: string, route: 'dispatch' | 'continuation') {
  const key = JSON.stringify(`agent-system:${route}:${pluginData}`);
  const tool = route === 'dispatch' ? 'create_thread' : 'send_message_to_thread';
  return `const prepared = load(${key});
if (!prepared || prepared.status !== 'prepared') throw new Error('${route}-prepared-request-unavailable');
store(${key}, null);
text({id: prepared.id, native: await tools.mcp__codex_app__${tool}(prepared.request)});`;
}
