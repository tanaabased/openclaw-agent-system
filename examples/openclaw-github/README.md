# OpenClaw GitHub Example

Install two managed GitHub identities, execute one real identity request as each agent, and verify that native OpenClaw profiles and repeat installation preserve separate credentials and Git authors.

## What Belongs Here

- Distinct installed native profiles and manifest-derived author identities.
- Managed agent/tool calls using each agent's actual account, independently observed through native profile status.
- Repeat installation preserving the verified profile bindings.

## What Does Not Belong Here

- A matrix of configuration-mutation or self-unassignment policy probes; installed command boundaries also have coverage in [tools](../openclaw-tools/README.md). Preserve model-facing refusal evidence when selecting its final owner.
- SSH registration and remote checkout: [worktree sessions](../openclaw-worktree-session/README.md). Notification content creation: [intake](../openclaw-notifications-intake/README.md).

## Notes

- Strict AIMock drives the real Gateway/tools without testing model judgment. Ubuntu CI supplies the existing Tanaabot and EMORI tokens; identity requests are read-only.
- The Gateway may reuse account identity proof for an unchanged credential binding. The explicit identity requests below still execute under each selected agent's real credential; a cached preflight must not change their account.
- Pending relocation: additional model turns verify generated-config mutation rejection and self-unassignment rejection. The latter uses a nonexistent issue and must stop locally before remote mutation.
- This job creates no GitHub issues, PRs, or SSH registrations.

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
