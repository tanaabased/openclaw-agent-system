# OpenClaw Worktree Example

Verify the installed managed worktree lifecycle against a disposable local repository: prepare, reuse without losing edits, execute Git with the owning agent identity, and remove safely. Public Agent System commands own preparation and removal; both the public Git command and the packaged contextual shim must discover the agent from inside the worktree.

Runtime tests run this example on Ubuntu without a model, Gateway, or provider credentials. The fixture is copied because the scenario creates a repository and modifies its worktree. Keep the older `worktree` example as a migration input until this replacement passes CI.

## Setup

```bash
# should install a disposable agent with a declared local repository
openclaw-setup --workspace "$TMPDIR/main" --agent-system "$AGENT_SYSTEM_PACKAGE"
mkdir -p "$TMPDIR/worktree-tanaabot/source"
cp "$GITHUB_WORKSPACE/examples/openclaw-worktree/agent.yaml" "$TMPDIR/worktree-tanaabot/agent.yaml"
cd "$TMPDIR/worktree-tanaabot"
git init --initial-branch=main source
printf '%s\n' 'tracked source content' > source/tracked.txt
git -C source add tracked.txt
git -C source -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit -m 'seed local fixture'
git -C source rev-parse HEAD > "$TMPDIR/worktree-source-head"
printf '%s\n' 'preserve source edits' > source/source-user.txt
openclaw agent-system install --yes --json | jq -e '.agentId == "worktree-tanaabot"'
```

## Testing

```bash
# should prepare one managed worktree from the declared local repository
cd "$TMPDIR/worktree-tanaabot"
openclaw agent-system tool worktree -- prepare fixture 306-critical-path HEAD | tee "$TMPDIR/worktree-created.json" | jq -e '.status == "created" and .repositoryId == "fixture" and (.branch == (.path | split("/") | last))'
worktree_path=$(jq -er .path "$TMPDIR/worktree-created.json")
grep -Fx 'tracked source content' "$worktree_path/tracked.txt"
openclaw agent-system tool worktree -- list fixture | jq -e --arg path "$worktree_path" 'length == 1 and .[0].status == "active" and .[0].path == $path'

# should reuse the same worktree while preserving uncommitted edits
cd "$TMPDIR/worktree-tanaabot"
worktree_path=$(jq -er .path "$TMPDIR/worktree-created.json")
printf '%s\n' 'preserve worktree edits' > "$worktree_path/user-work.txt"
openclaw agent-system tool worktree -- prepare fixture 306-critical-path HEAD | tee "$TMPDIR/worktree-reused.json" | jq -e '.status == "existing"'
jq -e --slurp '.[0].path == .[1].path and .[0].branch == .[1].branch' "$TMPDIR/worktree-created.json" "$TMPDIR/worktree-reused.json"
grep -Fx 'preserve worktree edits' "$worktree_path/user-work.txt"

# should discover the owning identity from inside the worktree through both git entrypoints
plugin_dir=$(openclaw plugins inspect agent-system --json | jq -er '.plugin.rootDir')
cd "$(jq -er .path "$TMPDIR/worktree-created.json")"
openclaw agent-system tool git -- var GIT_AUTHOR_IDENT | grep -F 'Worktree Tanaabot <tanaabot@tanaab.dev>'
"$plugin_dir/bin/git" var GIT_AUTHOR_IDENT | grep -F 'Worktree Tanaabot <tanaabot@tanaab.dev>'

# should refuse to remove a dirty worktree without losing its edits
cd "$TMPDIR/worktree-tanaabot"
if output=$(openclaw agent-system tool worktree -- remove fixture 306-critical-path 2>&1); then
  printf '%s\n' "$output"
  exit 1
fi
printf '%s\n' "$output" | grep -F 'code=execution_failed'
worktree_path=$(jq -er .path "$TMPDIR/worktree-created.json")
grep -Fx 'preserve worktree edits' "$worktree_path/user-work.txt"

# should remove the clean worktree while preserving the source checkout and its edits
cd "$TMPDIR/worktree-tanaabot"
worktree_path=$(jq -er .path "$TMPDIR/worktree-created.json")
rm "$worktree_path/user-work.txt"
openclaw agent-system tool worktree -- remove fixture 306-critical-path | jq -e '.status == "removed"'
test ! -e "$worktree_path"
openclaw agent-system tool worktree -- list fixture | jq -e 'length == 0'
test -d source/.git
test "$(git -C source rev-parse HEAD)" = "$(cat "$TMPDIR/worktree-source-head")"
git -C source branch --show-current | grep -Fx main
grep -Fx 'tracked source content' source/tracked.txt
grep -Fx 'preserve source edits' source/source-user.txt
```
