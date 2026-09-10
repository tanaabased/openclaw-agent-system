# Control UI artwork compatibility

Agent System publishes the GitHub notification channel catalog through both
`package.json#openclaw.channel` and its runtime `ChannelPlugin.meta`. Those
surfaces intentionally retain distinct public identities:

- plugin id: `agent-system`
- channel id: `agent-system-github`

## OpenClaw 2026.9.2 and 2026.9.3

The web Channels settings page in both supported versions associates packaged
plugin artwork only when the channel id is also a loaded plugin id. It then
requests that plugin icon using the channel id. Because Agent System is a
multi-capability plugin, its channel id does not and must not equal its plugin
id. The page therefore does not request the packaged `assets/icon.png` for this
channel.

`ChannelMeta.systemImage` reaches the channel status snapshot, but the web
Channels page does not use that field as channel-tile artwork. The public
`PluginPackageChannel` and `ChannelMeta` contracts expose no channel-specific
raster image path or owning-plugin association. Adding another PNG would be a
dead asset, not a visual fix.

## Platform prerequisite

Custom GitHub artwork can be shown without renaming or migrating either public
id after OpenClaw exposes and consumes one supported association:

1. a channel-specific artwork field whose package-relative asset is served by
   the Gateway and rendered by Control UI; or
2. an owning-plugin id on channel catalog entries that lets Control UI resolve
   `agent-system-github` to the `agent-system` plugin icon.

Until then, Agent System publishes all supported channel metadata consistently,
keeps the existing GitHub SVG artwork and canonical plugin icon packaged, and
does not claim that `systemImage` repairs the web rendering gap.
