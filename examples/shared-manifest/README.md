# Shared manifest loading

Install the candidate package into a separate Node.js consumer, then import the
supported manifest loader and read external automation and prompt definitions.
The consumer receives normalized definitions without provisioning its declared environment.

## What Belongs Here

- Packed JavaScript and TypeScript imports through the supported `/manifest` subpath.
- Passive definition loading without an OpenClaw installation or Agent System binding in the consumer.

## What Does Not Belong Here

- Runtime setup, credential resolution, schedule activation or Tanaabot integration.
- Parser and unsafe-reference permutations, covered by manifest unit and component tests.

## Notes

- Run only in GitHub Actions. The workspace contains deliberately unavailable environment inputs.
- The isolated consumer omits the OpenClaw peer dependency; no Gateway is started.

## Setup

```bash
# should install the exact prepared package into an isolated consumer without openclaw
root="$TMPDIR/agent-system-manifest-consumer"
mkdir -p "$root"
printf '%s\n' '{"private":true,"type":"module"}' > "$root/package.json"
npm install --prefix "$root" --ignore-scripts --legacy-peer-deps --omit=optional "$AGENT_SYSTEM_PACKAGE"
cp "$GITHUB_WORKSPACE/examples/shared-manifest/consumer.mts.txt" "$root/consumer.mts"
cp -R "$GITHUB_WORKSPACE/examples/shared-manifest/definitions" "$root/definitions"
test ! -d "$root/node_modules/openclaw"
```

## Testing

```bash
# should resolve the published declarations in an independent typescript consumer
root="$TMPDIR/agent-system-manifest-consumer"
node "$GITHUB_WORKSPACE/node_modules/typescript/bin/tsc" --ignoreConfig --noEmit --strict --module nodenext --target esnext --types node --typeRoots "$GITHUB_WORKSPACE/node_modules/@types" "$root/consumer.mts"

# should load definitions through the public node import without a running host
node "$TMPDIR/agent-system-manifest-consumer/consumer.mts" | grep -F 'portable definitions loaded'
```
