# Setup Example

Tests public setup installation, agent-bound GitHub identity and SSH cloning,
check/apply/recheck, unchanged reruns, unchecked steps, Doctor, and skipping setup.
It uses direct assertions against the packed plugin, with no Gateway or model.

## Setup

```bash
# should configure the packed plugin with an isolated ssh fixture
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE" \
  --needs-ssh-key

# should prepare the workspace declaration and github host trust
mkdir -p "$TMPDIR/setup-tanaabot" "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
cp "$GITHUB_WORKSPACE/fixtures/github.com.known_hosts" "$HOME/.ssh/known_hosts"
chmod 600 "$HOME/.ssh/known_hosts"
cp "$HOME/.ssh/big-test-bucket-ssh.pub" "$TMPDIR/setup-tanaabot/setup-key.pub"
runner_os="$(printf '%s' "$RUNNER_OS" | tr '[:upper:]' '[:lower:]')"
sed \
  -e "s/__GITHUB_RUN_ID__/$GITHUB_RUN_ID/g" \
  -e "s/__GITHUB_RUN_ATTEMPT__/$GITHUB_RUN_ATTEMPT/g" \
  -e "s/__RUNNER_OS__/$runner_os/g" \
  "$GITHUB_WORKSPACE/examples/setup/tanaabot/agent.yaml" > "$TMPDIR/setup-tanaabot/agent.yaml"
```

## Testing

```bash
# should validate setup without executing its commands
cd "$TMPDIR/setup-tanaabot"
openclaw agent-system validate --json | jq -e '.checks | any(.component == "setup" and .status == "valid")'
test ! -e repository
test ! -e unchecked-runs

# should install prerequisites before cloning with the declared agent identity
cd "$TMPDIR/setup-tanaabot"
output="$(openclaw agent-system install --yes --json)"
printf '%s\n' "$output" | jq -e '.outcomes | any(.component == "github" and .code == "add-github-ssh-keys") and any(.stepId == "checkout" and .status == "updated") and any(.stepId == "repeatable" and .status == "updated")'
printf '%s\n' "$output" | jq -e '.outcomes | map(.component) | index("github") < index("setup") and index("setup") < index("tool-access")'
test -d repository/.git
grep -Fx 'tanaabot' github-login
grep -F 'Tanaabot <tanaabot@tanaab.dev>' git-identity
test "$(wc -l < checked-runs | tr -d ' ')" = 1
test "$(wc -l < unchecked-runs | tr -d ' ')" = 1

# should leave the checked step unchanged and repeat an unchecked apply without prompting
cd "$TMPDIR/setup-tanaabot"
openclaw as install --non-interactive --json | jq -e '.outcomes | any(.stepId == "checkout" and .status == "unchanged") and any(.stepId == "repeatable" and .status == "updated")'
test "$(wc -l < checked-runs | tr -d ' ')" = 1
test "$(wc -l < unchecked-runs | tr -d ' ')" = 2

# should inspect setup without running unchecked applies or requiring consent
cd "$TMPDIR/setup-tanaabot"
openclaw as doctor --json | jq -e '.findings | any(.stepId == "checkout" and .status == "healthy") and any(.stepId == "repeatable" and .status == "manual")'
test "$(wc -l < unchecked-runs | tr -d ' ')" = 2

# should skip setup while preserving one json result and a visible warning
cd "$TMPDIR/setup-tanaabot"
output="$(openclaw agent-system install --skip-setup --yes --json 2> "$TMPDIR/setup-skip.stderr")"
printf '%s\n' "$output" | jq -e '(.warnings | any(.code == "setup-skipped")) and (.outcomes | all(.component != "setup"))'
grep -F 'setup was skipped' "$TMPDIR/setup-skip.stderr"
test "$(wc -l < checked-runs | tr -d ' ')" = 1
test "$(wc -l < unchecked-runs | tr -d ' ')" = 2
```

## Cleanup

```bash
# should remove only the public key registered by this setup scenario
cd "$TMPDIR/setup-tanaabot"
key_material="$(awk '{ print $2 }' setup-key.pub)"
key_id="$(OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --paginate /user/keys --jq ".[] | select((.key | split(\" \") | index(\"$key_material\")) != null) | .id")"
if test -n "$key_id"; then
  OPENCLAW_LOG_LEVEL=error openclaw agent-system tool gh -- api --method DELETE "/user/keys/$key_id"
fi
```
