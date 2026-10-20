# OpenClaw GitHub Example

Verify two distinct GitHub identities through the packed plugin and real Gateway. Installation creates separate native OpenClaw profiles with manifest-derived Git authors; repeat installation preserves those bindings. Strict AIMock drives two managed GitHub identity calls and requires the real safe rejection reason for a generated-config mutation probe. Direct native profile status independently verifies that OpenClaw consumes the matching agent credentials.

Ubuntu CI supplies the existing Tanaabot and EMORI test tokens. Identity calls are read-only. A self-removal probe uses a nonexistent issue and must return the local assignment rejection before any remote mutation; this example creates no GitHub content. SSH-key provisioning and remote checkout belong to the worktree example.

## Setup

```bash
# should install the two declared identities with a strict model
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE" --yolo
openclaw-aimock prepare --scenario openclaw-github
cd "$GITHUB_WORKSPACE/examples/openclaw-github/tanaabot"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "create-openclaw-github-profile") and any(.code == "set-openclaw-github-profile")'
cd "$GITHUB_WORKSPACE/examples/openclaw-github/emori"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "create-openclaw-github-profile") and any(.code == "set-openclaw-github-profile")'
openclaw-gateway start
```

## Testing

```bash
# should retain separate profiles and author identities on repeat installation
first=$(openclaw config get agents.entries.tanaabot.tools.github.profileId --json | jq -er .)
second=$(openclaw config get agents.entries.emori.tools.github.profileId --json | jq -er .)
test "$first" != "$second"
openclaw config get agents.entries.tanaabot.tools.github.gitAuthor --json | jq -e '. == {"name":"MODEL L3-37","email":"tanaabot@tanaab.dev"}'
openclaw config get agents.entries.emori.tools.github.gitAuthor --json | jq -e '. == {"name":"EMORI","email":"emori@tanaab.dev"}'
cd "$GITHUB_WORKSPACE/examples/openclaw-github/tanaabot"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "openclaw-github-profile-unchanged") and any(.code == "openclaw-github-binding-unchanged")'
cd "$GITHUB_WORKSPACE/examples/openclaw-github/emori"
openclaw agent-system install --yes --json | jq -e '.outcomes | any(.code == "openclaw-github-profile-unchanged") and any(.code == "openclaw-github-binding-unchanged")'
test "$(openclaw config get agents.entries.tanaabot.tools.github.profileId --json | jq -er .)" = "$first"
test "$(openclaw config get agents.entries.emori.tools.github.profileId --json | jq -er .)" = "$second"

# should execute each managed github tool under its own account
openclaw agent --agent tanaabot --session-key agent:tanaabot:github-identity --message-file "$GITHUB_WORKSPACE/examples/openclaw-github/tanaabot/whoami.md" --timeout 120 | grep -F tanaabot
openclaw agent --agent emori --session-key agent:emori:github-identity --message-file "$GITHUB_WORKSPACE/examples/openclaw-github/emori/whoami.md" --timeout 120 | grep -F emoriwan

# should deliver the generated configuration boundary to the model
openclaw agent --agent tanaabot --session-key agent:tanaabot:github-validation --message-file "$GITHUB_WORKSPACE/examples/openclaw-github/tanaabot/validation.md" --timeout 120 | grep -F 'Managed configuration mutation was rejected.'

# should deliver the self-unassignment boundary to the model before remote mutation
openclaw agent --agent tanaabot --session-key agent:tanaabot:github-assignment --message-file "$GITHUB_WORKSPACE/examples/openclaw-github/tanaabot/assignment.md" --timeout 120 | grep -F 'Managed self-unassignment was rejected.'
openclaw-aimock evidence --scenario openclaw-github --expected-evidence "$GITHUB_WORKSPACE/examples/openclaw-github/expected-evidence.json"

# should expose the same distinct identities through native openclaw github profiles
for pair in tanaabot:tanaabot emori:emoriwan; do
  agent=$(printf '%s' "$pair" | cut -d : -f 1)
  login=$(printf '%s' "$pair" | cut -d : -f 2)
  openclaw gateway call tools.github.status --params "$(jq -nc --arg agent "$agent" '{agentId:$agent,selectedScope:"agent"}')" --timeout 30000 --json | jq -e --arg agent "$agent" --arg login "$login" '.agentId == $agent and .selectedScope == "agent" and .selected.configured == true and .selected.identity.source == "agent-override" and .selected.identity.credentialKind == "managed-pat" and .selected.identity.credentialState == "available" and .selected.identity.account.login == $login and .effective.account.login == $login'
done
```

## Cleanup

```bash
# should stop the isolated gateway and strict provider
openclaw-gateway stop --timeout 340
openclaw-aimock stop
```
