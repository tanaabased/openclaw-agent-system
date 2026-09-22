# Setup Example

Tests public setup installation, agent-bound GitHub identity and SSH cloning,
check/apply/recheck, unchanged reruns, unchecked steps, Doctor, and skipping setup.
It also covers partial failures, retries, nonconvergence, timeouts, and granular
Doctor findings. It uses direct assertions against the packed plugin, with no
Gateway or model.

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

# should preserve completed setup effects and stop later work after an apply failure
mkdir -p "$TMPDIR/setup-failures"
cp "$GITHUB_WORKSPACE/examples/setup/failures/agent.yaml" "$TMPDIR/setup-failures/agent.yaml"
cd "$TMPDIR/setup-failures"
touch block-later-check
if openclaw as install --yes --json > "$TMPDIR/setup-failed.stdout" 2> "$TMPDIR/setup-failed.stderr"; then exit 1; fi
grep -F 'setup-apply-failed' "$TMPDIR/setup-failed.stderr" | grep -F 'repair'
test ! -s "$TMPDIR/setup-failed.stdout"
if grep -F 'setup-private-output-sentinel' "$TMPDIR/setup-failed.stderr"; then exit 1; fi
grep -F 'Setup Test Agent <setup-failures@example.invalid>' git-identity
test "$(wc -l < preserved | tr -d ' ')" = 1
test ! -e later
test ! -e manual

# should inspect every step after failure without applying or repairing dependent state
cd "$TMPDIR/setup-failures"
if openclaw as doctor --json > "$TMPDIR/setup-failed-doctor.json"; then exit 1; fi
jq -e '.findings | any(.stepId == "preserved" and .status == "healthy") and any(.stepId == "repair" and .status == "drift") and any(.stepId == "later" and .status == "blocked") and any(.stepId == "manual" and .status == "manual") and any(.component == "tool-access" and .status == "drift")' "$TMPDIR/setup-failed-doctor.json"
test "$(wc -l < attempts | tr -d ' ')" = 1
test ! -e later
test ! -e manual

# should resume a partial installation unattended without repeating completed steps
cd "$TMPDIR/setup-failures"
touch allow-repair
rm block-later-check
CI=0 NONINTERACTIVE=0 openclaw as install --json < /dev/null | jq -e '.outcomes | any(.stepId == "preserved" and .status == "unchanged") and any(.stepId == "repair" and .status == "updated") and any(.stepId == "later" and .status == "updated") and any(.component == "tool-access" and .status == "updated")'
test "$(wc -l < preserved | tr -d ' ')" = 1
test "$(wc -l < attempts | tr -d ' ')" = 2
test -f later
test -f manual

# should reject a successful apply whose check still reports drift
cd "$TMPDIR/setup-failures"
cp "$GITHUB_WORKSPACE/examples/setup/failures/nonconvergent.yaml" agent.yaml
if openclaw as install --yes --json > "$TMPDIR/setup-nonconvergent.stdout" 2> "$TMPDIR/setup-nonconvergent.stderr"; then
  cat "$TMPDIR/setup-nonconvergent.stdout" "$TMPDIR/setup-nonconvergent.stderr" >&2
  exit 1
fi
if ! grep -F 'setup-not-converged' "$TMPDIR/setup-nonconvergent.stderr" | grep -F 'nonconvergent'; then
  cat "$TMPDIR/setup-nonconvergent.stdout" "$TMPDIR/setup-nonconvergent.stderr" >&2
  exit 1
fi
test ! -s "$TMPDIR/setup-nonconvergent.stdout"
test -f nonconvergent-applied
test ! -e forbidden-later

# should stop installation after a direct command times out
cd "$TMPDIR/setup-failures"
cp "$GITHUB_WORKSPACE/examples/setup/failures/timeout.yaml" agent.yaml
if openclaw as install --non-interactive --json > "$TMPDIR/setup-timeout.stdout" 2> "$TMPDIR/setup-timeout.stderr"; then
  cat "$TMPDIR/setup-timeout.stdout" "$TMPDIR/setup-timeout.stderr" >&2
  exit 1
fi
if ! grep -F 'setup-apply-failed' "$TMPDIR/setup-timeout.stderr" | grep -F 'timeout'; then
  cat "$TMPDIR/setup-timeout.stdout" "$TMPDIR/setup-timeout.stderr" >&2
  exit 1
fi
test ! -s "$TMPDIR/setup-timeout.stdout"
test ! -e forbidden-later
test ! -e timeout-survived
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
