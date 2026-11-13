import { registerHooks } from 'node:module';
import { threadId } from 'node:worker_threads';

// temporary ci instrumentation: no installed files, request data, or error messages are changed.
export function tracePluginLifetime(event, details = {}) {
  const frames = {};
  if (event === 'instance-unavailable') Error.captureStackTrace(frames, tracePluginLifetime);
  process.stderr.write(
    `[agent-system:lifetime] ${JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      monotonicMs: performance.now(),
      pid: process.pid,
      threadId,
      ...details,
      ...(event === 'instance-unavailable'
        ? {
            stack: String(frames.stack)
              .split('\n')
              .slice(1, 21)
              .map((line) => line.slice(0, 500)),
          }
        : {}),
    })}\n`,
  );
}

const targets = [
  {
    file: /\/openclaw\/dist\/plugin-cache-[^/]+\.mjs$/,
    symbol: 'PluginInstanceUnavailableError',
    replacements: [
      [
        'this.name = "PluginInstanceUnavailableError";',
        'this.name = "PluginInstanceUnavailableError"; __asLifetimeTrace("instance-unavailable");',
      ],
    ],
  },
  {
    file: /\/openclaw\/dist\/server-plugin-reload-[^/]+\.mjs$/,
    symbol: 'reloadGatewayPlugins',
    replacements: [
      [
        'const operationId = params.pluginLifecycle?.operationId ?? randomUUID();',
        'const operationId = params.pluginLifecycle?.operationId ?? randomUUID(); __asLifetimeTrace("reload-start", {operationId, generation: getPluginRuntimeGeneration()});',
      ],
      [
        'log.info(`Plugin replacement applied: ${[...changedPluginIds].join(", ")}`);',
        'log.info(`Plugin replacement applied: ${[...changedPluginIds].join(", ")}`); __asLifetimeTrace("reload-published", {operationId, generation: getPluginRuntimeGeneration()});',
      ],
      [
        'await recovery.dispose();',
        'await recovery.dispose(); __asLifetimeTrace("reload-finished", {operationId, generation: getPluginRuntimeGeneration(), phase, committed, restored});',
      ],
    ],
  },
];

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const target = targets.find(({ file }) => file.test(url));
    if (!target) return result;
    let source = Buffer.from(result.source).toString('utf8');
    if (!source.includes(target.symbol)) return result;
    for (const [anchor, replacement] of target.replacements) {
      if (source.split(anchor).length !== 2) {
        throw new Error('CI lifetime instrumentation does not match the installed OpenClaw build');
      }
      source = source.replace(anchor, replacement);
    }
    tracePluginLifetime('instrumented', { module: url.split('/').at(-1) });
    return {
      ...result,
      source: `import { tracePluginLifetime as __asLifetimeTrace } from ${JSON.stringify(import.meta.url)};\n${source}`,
    };
  },
});
