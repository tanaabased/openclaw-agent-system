/** Use the same pre-model condition and bounded diagnostics for both GitHub coordinators. */
export default function openClawDispatchTrigger(
  input: { action: 'check' } | { action: 'review'; operation: 'check' },
) {
  return [
    'function unwrap(v){if(typeof v === "string")return unwrap(JSON.parse(v));if(v.output)return unwrap(v.output);if(v.content)return unwrap(v.content.filter(x=>x.type==="text").map(x=>x.text).join("\\n"));return v;}',
    'let stage="dispatch"; const started=Date.now();',
    'try {',
    'stage="dispatch";',
    `const d=unwrap(await agent_system_dispatch(${JSON.stringify(input)}));`,
    'if (!d || d.status!=="ready" || typeof d.changed!=="boolean") throw new Error("dispatch-condition-invalid");',
    'json({fire:d.changed===true,state:{status:d.status,outcome:d.outcome,more:d.more,code:d.code,diagnostic:d.diagnostic,obstacles:d.obstacles}});',
    '} catch (error) { const code=[error?.code,error?.message].find(value=>typeof value==="string" && /^(?:intake|dispatch|review|feedback|continuation|github|automation|private-state)-[a-z0-9-]{1,100}$/.test(value))??stage+"-condition-failed"; json({fire:true,state:{status:code.endsWith("-busy")?"busy":"failed",stage,code,diagnostic:{phase:stage,elapsedMs:Math.max(0,Date.now()-started),reason:["AbortError","TimeoutError","TypeError","SyntaxError"].includes(error?.name)?error.name:code}}}); }',
  ].join('\n');
}
