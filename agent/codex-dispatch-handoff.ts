import { nativeObject } from './automation-gateway.ts';

interface CodexRuntimeIdentity {
  entrypoint: string;
  pluginData: string;
}

/** scheduled transport retains exact routing evidence and never performs a native handoff. */
export default function codexDispatchHandoff(runtime: CodexRuntimeIdentity) {
  return `const runtime = ${JSON.stringify({ entrypoint: runtime.entrypoint, pluginData: runtime.pluginData })};
${String.raw`const actions = {
  intake: ['scan', 'pickup', 'failure-response'],
  dispatch: ['observe-denials', 'next', 'prepare', 'reconcile', 'report'],
  continuation: ['next', 'reconcile'],
  feedback: ['reconcile']
};
async function executeRuntime(runtimeRoute, runtimeInput) {
if (!actions[runtimeRoute]?.includes(runtimeInput.action)) throw new Error('scheduled-runtime-action-unsupported');
const key = 'agent-system:' + runtimeRoute + ':' + runtime.pluginData;
store(key, null);
let input = runtimeInput;
const argv = ['node', runtime.entrypoint, runtimeRoute];
argv.push(input.action);
argv.push('--plugin-data', runtime.pluginData);
const request = {...input};
if (runtimeRoute === 'intake') delete request.action;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = argv.map(quote).join(' ') + " <<'AGENT_SYSTEM_INPUT'\n" + JSON.stringify(request) + '\nAGENT_SYSTEM_INPUT';
let busyRetries = 0;
while (true) {
  let result = await tools.exec_command({
    cmd: command, max_output_tokens: 32000,
    ...{
      sandbox_permissions: 'require_escalated',
      justification: runtimeRoute === 'intake' && input.action === 'pickup'
        ? 'Allow this occurrence of the activated issue pickup workflow to verify candidates, update its private journal, and self-assign at most one eligible GitHub issue under the designated installation policy? Native denials stop the operation.'
        : 'Allow ' + runtimeRoute + ':' + input.action + ' for the operator-activated recurring assignment workflow? This exact command checks workflow evidence, prepares configured repositories when required, and updates private tracking state; it does not create chats, send turns, implement task code, or publish to GitHub. Eligible assignments are selected by the activated manifest policy. Current operator restrictions and native approval decisions still apply.',
      prefix_rule: argv
    }
  });
  let output = result.output;
  while (result.session_id !== undefined) {
    result = await tools.write_stdin({session_id: result.session_id, chars: '', max_output_tokens: 32000});
    output += result.output;
  }
  text({...result, output});
  let response;
  try { response = JSON.parse(output); } catch { /* raw host-access failures may not be json */ }
  if (result.exit_code === 127 && /\bnode: (?:command )?not found\b|\bcommand not found: node\b/u.test(output)) {
    throw new Error('codex-node-unavailable: put a Node.js version supported by this plugin package.json#engines.node on the configured host PATH, then retry; no automation rewrite is needed. The runtime failure formatter cannot start until Node is available.');
  }
  if (response?.code === 'codex-node-version-unsupported') throw new Error(response.message);
  const busy = response?.status === 'busy' || response?.code === 'private-state-file-lock-busy';
  if (busy && busyRetries < 3) {
    busyRetries++;
    await new Promise(resolve => setTimeout(resolve, 2000));
    continue;
  }
  if (busy) return response;
  if (result.exit_code !== 0 || !response) throw new Error('native-handoff-preparation-failed; inspect the command result and reconcile before retrying');
  store(key, response);
  store(key + ":observation", null);
  return response;
}
}
const response = await executeRuntime(runtimeRoute, runtimeInput);
if (runtimeRoute === 'intake' && runtimeInput.action === 'scan' && response?.status === 'ready') {
  const observed = await executeRuntime('dispatch', {action: 'observe-denials'});
  if (observed?.status === 'ready') await executeRuntime('continuation', {action: 'next'});
}`}`;
}

/** consume the exact request once, separately from host-access preparation. */
export function codexNativeHandoff(
  pluginData: string,
  route: 'dispatch' | 'continuation' | 'retirement',
) {
  const key = JSON.stringify(
    `agent-system:${route === 'retirement' ? 'dispatch' : route}:${pluginData}`,
  );
  const status = route === 'retirement' ? 'retirement-prepared' : 'prepared';
  const tool =
    route === 'retirement'
      ? 'set_thread_archived'
      : route === 'dispatch'
        ? 'create_thread'
        : 'send_message_to_thread';
  return `const prepared = load(${key});
if (!prepared || prepared.status !== '${status}') throw new Error('${route}-prepared-request-unavailable');
store(${key}, null);


text({id: prepared.id, native: await tools.mcp__codex_app__${tool}(prepared.request)});`;
}

/** carry the exact prepared input without depending on a separate ephemeral store write. */
export function codexFeedbackHandoff(request: { threadId: string; prompt: string }) {
  return `text(await tools.mcp__codex_app__send_message_to_thread(${JSON.stringify(request)}));`;
}

/** one desktop observation, then the original context invocation through normal native approval. */
export function codexWorkObservationHandoff(
  value: unknown,
  invocation: { argv: string[]; input: Record<string, unknown> },
) {
  if (
    !nativeObject(value) ||
    value.status !== 'observation-required' ||
    value.code !== 'continuation-turn-state-unresolved' ||
    value.reason !== undefined ||
    !nativeObject(value.request) ||
    value.request.tool !== 'read_thread' ||
    !nativeObject(value.request.arguments) ||
    invocation.input.action !== 'context'
  )
    return value;
  const quote = (part: string) => "'" + part.replaceAll("'", "'\\''") + "'";
  const command =
    invocation.argv.map(quote).join(' ') +
    " <<'AGENT_SYSTEM_INPUT'\n" +
    JSON.stringify(invocation.input) +
    '\nAGENT_SYSTEM_INPUT';
  return {
    ...value,
    instruction:
      'Execute nativeHandoff once in functions.exec. It reads the same desktop turn and retries this exact authorized context command. Inspect its completed output; if evidence remains incomplete, stop with that explanation. Do not repeat the handoff, poll for agreement, or send a replacement turn.',
    nativeHandoff: `async function observeAndContinue() {
  if (typeof tools.mcp__codex_app__read_thread !== 'function') {
    text({status: 'unresolved', code: 'continuation-native-observation-unavailable', instruction: 'Supported Codex desktop read_thread is unavailable. Restore the native desktop tool connection, then retry the original context command; do not send a replacement turn.'});
    return;
  }
  const native = await tools.mcp__codex_app__read_thread(${JSON.stringify(value.request.arguments)});
  text({native});
  if (native?.isError === true) {
    text({status: 'unresolved', code: 'continuation-native-observation-failed', instruction: 'The desktop read failed. Resolve its native diagnostic before retrying context; do not repeat the handoff or send a replacement turn.'});
    return;
  }
  let result = await tools.exec_command({
    cmd: ${JSON.stringify(command)},
    sandbox_permissions: 'require_escalated',
    justification: 'Allow the original authorized work transition to recheck native desktop evidence, task ownership and live policy? Native denials stop the operation.',
    prefix_rule: ${JSON.stringify(invocation.argv)},
    max_output_tokens: 32000
  });
  let output = result.output;
  while (result.session_id !== undefined) {
    result = await tools.write_stdin({session_id: result.session_id, chars: '', max_output_tokens: 32000});
    output += result.output;
  }
  text({...result, output});
  let response;
  try { response = JSON.parse(output); } catch { return; }
  if (response?.status === 'observation-required')
    text({status: 'unresolved', code: response.code, reason: response.reason ?? 'native-observation-receipt-unavailable', instruction: 'The one-shot desktop observation did not establish current turn custody. Stop and report this recoverable limitation; do not repeat the handoff or poll for agreement.'});
}
await observeAndContinue();`,
  };
}
