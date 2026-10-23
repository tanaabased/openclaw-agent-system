# OS Credentials Example

Use private managed storage and a local signing key on macOS and Linux, verify a trusted signed commit, and refuse unsafe permissions or symlink escapes without exposing credentials or damaging peer/outside state.

## What Belongs Here

- Private owned directories, agent-scoped file credential removal, and preservation of another agent's credential.
- Native key access and independently verified SSH commit signing under the installed managed identity.
- Refusals for unsafe modes and redirected paths, preserving the original file, peer credential, and outside target rather than repairing or following them.

## What Does Not Belong Here

- Keychain/Secret Service device enrollment: [dispatch enrollment](../os-dispatch-enrollment/README.md). Real provider resolution/cache: [credentials](../openclaw-credentials/README.md).
- Remote SSH-key registration, hosted GitHub content, Gateway sessions, or model behavior.

## Notes

- Synthetic file-store tokens exercise public credential removal. Creation/provider validation remain separate because `credentials set op` requires a real declared 1Password resource.
- The generated SSH key is local and never registered remotely. A private dotenv fixture supplies it to the signing binding; native Git verifies the resulting commit against its public key.
- Workspaces run under temporary paths containing spaces with separate outside targets. Node mode checks avoid platform-specific `stat` flags.
- Negative permission/path cases are essential native safety coverage, not optional detours. All checks run directly without a Gateway, model, or external service.

## Setup

```bash
# should configure an isolated profile with the packed plugin
openclaw-setup \
  --workspace "$TMPDIR/main" \
  --agent-system "$AGENT_SYSTEM_PACKAGE"

# should install isolated agents with a local ssh key and synthetic file credentials
umask 077
mkdir -p "$TMPDIR/os storage"
cp -R "$GITHUB_WORKSPACE/examples/os-credentials/alpha" "$TMPDIR/os storage/alpha"
cp -R "$GITHUB_WORKSPACE/examples/os-credentials/beta" "$TMPDIR/os storage/beta"
mkdir "$TMPDIR/os storage/alpha/keys"
ssh-keygen -q -t ed25519 -N '' -f "$TMPDIR/os storage/alpha/keys/id_ed25519"
node -e 'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"OS_SIGNING_KEY="+JSON.stringify(fs.readFileSync(process.argv[2],"utf8"))+"\n",{mode:0o600});' "$TMPDIR/os storage/alpha/.signing.env" "$TMPDIR/os storage/alpha/keys/id_ed25519"
printf 'storage-alpha@example.invalid %s\n' "$(cat "$TMPDIR/os storage/alpha/keys/id_ed25519.pub")" > "$TMPDIR/os storage/alpha/allowed_signers"
mkdir -p "$TMPDIR/os storage/config/tanaab/agent-system/storage-alpha" "$TMPDIR/os storage/config/tanaab/agent-system/storage-beta"
printf '%s' synthetic-alpha-credential > "$TMPDIR/os storage/config/tanaab/agent-system/storage-alpha/op-token"
printf '%s' synthetic-beta-credential > "$TMPDIR/os storage/config/tanaab/agent-system/storage-beta/op-token"
cd "$TMPDIR/os storage/alpha"
openclaw agent-system install
cd "$TMPDIR/os storage/beta"
openclaw agent-system install
```

## Testing

```bash
# should create private managed state directories for both agents
node -e 'const fs=require("node:fs");const assert=require("node:assert/strict");for(const agent of ["alpha","beta"]){for(const name of ["repositories","worktrees"]){const s=fs.lstatSync(process.argv[1]+"/"+agent+"/.agent-system/"+name);assert.ok(s.isDirectory());assert.equal(s.mode&0o777,0o700);assert.equal(s.uid,process.getuid());}}' "$TMPDIR/os storage"

# should remove only the selected agent file credential without exposing either token
cd "$TMPDIR/os storage/alpha"
output=$(XDG_CONFIG_HOME="$TMPDIR/os storage/config" openclaw agent-system credentials unset op --store file 2>&1)
printf '%s\n' "$output" | grep -F 'op credential removed'
if printf '%s\n' "$output" | grep -F synthetic-; then exit 1; fi
test ! -e "$TMPDIR/os storage/config/tanaab/agent-system/storage-alpha/op-token"
node -e 'const fs=require("node:fs");const assert=require("node:assert/strict");assert.equal(fs.readFileSync(process.argv[1],"utf8"),"synthetic-beta-credential");' "$TMPDIR/os storage/config/tanaab/agent-system/storage-beta/op-token"

# should reject a group-readable credential without removing or repairing it
credential="$TMPDIR/os storage/config/tanaab/agent-system/storage-alpha/op-token"
printf '%s' synthetic-alpha-credential > "$credential"
chmod 644 "$credential"
cd "$TMPDIR/os storage/alpha"
if output=$(XDG_CONFIG_HOME="$TMPDIR/os storage/config" openclaw agent-system credentials unset op --store file 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=credential-file-permissions'
if printf '%s\n' "$output" | grep -F synthetic-; then exit 1; fi
node -e 'const fs=require("node:fs");const assert=require("node:assert/strict");assert.equal(fs.readFileSync(process.argv[1],"utf8"),"synthetic-alpha-credential");assert.equal(fs.lstatSync(process.argv[1]).mode&0o777,0o644);' "$credential"

# should refuse a credential symlink while preserving the peer credential and link
credential="$TMPDIR/os storage/config/tanaab/agent-system/storage-alpha/op-token"
rm "$credential"
ln -s "$TMPDIR/os storage/config/tanaab/agent-system/storage-beta/op-token" "$credential"
cd "$TMPDIR/os storage/alpha"
if output=$(XDG_CONFIG_HOME="$TMPDIR/os storage/config" openclaw agent-system credentials unset op --store file 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=credential-file-symlink'
if printf '%s\n' "$output" | grep -F synthetic-; then exit 1; fi
test -L "$credential"
node -e 'const fs=require("node:fs");const assert=require("node:assert/strict");assert.equal(fs.readFileSync(process.argv[1],"utf8"),"synthetic-beta-credential");' "$TMPDIR/os storage/config/tanaab/agent-system/storage-beta/op-token"

# should create a trusted signed commit under the installed managed identity
mkdir "$TMPDIR/os storage/alpha/repository"
cd "$TMPDIR/os storage/alpha/repository"
openclaw agent-system tool git -- init --quiet
openclaw agent-system tool git -- commit --quiet --allow-empty --message 'verify managed signing'
git log -1 --format='%an <%ae> | %cn <%ce>' | grep -Fx 'Storage Alpha <storage-alpha@example.invalid> | Storage Alpha <storage-alpha@example.invalid>'
git -c gpg.format=ssh -c "gpg.ssh.allowedSignersFile=$TMPDIR/os storage/alpha/allowed_signers" verify-commit HEAD

# should reject a group-readable ssh key without repairing its permissions
cd "$TMPDIR/os storage/alpha"
chmod 644 keys/id_ed25519
if output=$(openclaw agent-system tool git -- var GIT_AUTHOR_IDENT 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=credential_unavailable'
if printf '%s\n' "$output" | grep -F 'BEGIN OPENSSH PRIVATE KEY'; then exit 1; fi
node -e 'const fs=require("node:fs");const assert=require("node:assert/strict");assert.equal(fs.lstatSync("keys/id_ed25519").mode&0o777,0o644);'
chmod 600 keys/id_ed25519

# should reject a relative ssh key redirected through an outside parent directory
cd "$TMPDIR/os storage/alpha"
mv keys "$TMPDIR/os storage/outside-keys"
cp "$TMPDIR/os storage/outside-keys/id_ed25519" "$TMPDIR/os storage/key.expected"
ln -s "$TMPDIR/os storage/outside-keys" keys
if output=$(openclaw agent-system tool git -- var GIT_AUTHOR_IDENT 2>&1); then exit 1; fi
printf '%s\n' "$output" | grep -F 'code=credential_unavailable'
if printf '%s\n' "$output" | grep -F 'BEGIN OPENSSH PRIVATE KEY'; then exit 1; fi
test -L keys
cmp "$TMPDIR/os storage/key.expected" "$TMPDIR/os storage/outside-keys/id_ed25519"
rm keys
mv "$TMPDIR/os storage/outside-keys" keys

# should refuse installation into a symlinked managed root without changing its target
cd "$TMPDIR/os storage/alpha"
rmdir .agent-system/repositories
mkdir "$TMPDIR/os storage/outside-state"
printf '%s\n' preserve > "$TMPDIR/os storage/outside-state/sentinel"
ln -s "$TMPDIR/os storage/outside-state" .agent-system/repositories
if output=$(openclaw agent-system install --json); then exit 1; fi
printf '%s\n' "$output" | jq -e '.status == "failed" and .blocked.component == "git" and (.blocked.code == "git-worktrees-reconcile-failed" or .blocked.code == "git-repositories-root-unsafe")'
test -L .agent-system/repositories
node -e 'const fs=require("node:fs");const assert=require("node:assert/strict");assert.deepEqual(fs.readdirSync(process.argv[1]),["sentinel"]);assert.equal(fs.readFileSync(process.argv[1]+"/sentinel","utf8"),"preserve\n");' "$TMPDIR/os storage/outside-state"
```
