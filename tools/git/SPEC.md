# Agent System Git Tool Specification

## Status

This document defines the Agent System Git tool. It owns Git-specific
configuration, execution, policy, SSH authentication, signing, documentation,
and verification decisions. The root [product specification](../../SPEC.md)
owns the shared environment, tool-runtime, lifecycle, and security contracts.

The active tool provides agent identity projection, working-directory
containment, operation policy, isolated SSH authentication, and environment-bound
SSH commit and tag signing with optional local trusted verification. Explicitly
allowed worktrees are the only planned Git feature. Encrypted keys, passphrase
delivery, and workstation integration with the 1Password desktop SSH agent
remain deferred.

## Product Boundary

The Git tool runs the real `git` executable as the active Agent System agent. It
provides one execution path for model calls, explicit operator commands, and the
packaged `git` shim without changing the Gateway environment or storing managed
identity in the operator's global or repository Git configuration. Requested
Git operations such as `init` or `clone` may still create ordinary repository
configuration as part of Git's own behavior.

The stable surfaces are:

| Surface                          | Purpose                                  |
| -------------------------------- | ---------------------------------------- |
| `agent_system_git`               | Model-facing OpenClaw tool               |
| `openclaw agent-system tool git` | Explicit operator command                |
| `git`                            | Packaged compatibility shim              |
| `skills/git-cli`                 | Concise model-facing Git guidance        |
| `tools/git/README.md`            | User-facing tool and configuration guide |

The tool binds the active agent from trusted OpenClaw or installed-agent
context. The model never supplies an agent id, executable path, credential
selector, secret reference, SSH socket, or signing key.

The Git tool does not replace GitHub provider operations. Repository, issue,
pull-request, release, Actions, and GitHub API work remains owned by the
[GitHub CLI tool](../github/README.md).

## Manifest Contract

The presence of `git` enables the managed Git capability for an agent. The
section is strict, uses kebab-case keys, and is statically composed into the root
manifest schema from `tools/git/config-schema.ts`.

The identity surface is:

```yaml
schema-version: 1

agent:
  id: tanaabot
  name: Tanaabot
  email:
    from-environment: AGENT_EMAIL

git:
  # optional; defaults to agent.name
  name: Tanaabot

  # optional; defaults to agent.email
  email:
    from-environment: GIT_EMAIL

  extensions:
    lfs: allow
    town: ask

  policy:
    delete: deny
    discard: deny
    force: deny
    rewrite: deny
    unknown: deny
```

`git.name` and `git.email` accept the standard Agent System resolvable-string
forms: a literal string or an object containing `from-environment`. Environment
bindings resolve from the completed Agent System environment after the active
agent is trusted.

Effective identity follows this order:

1. `git.name` or `git.email`;
2. the corresponding `agent.name` or `agent.email`; and
3. a stable validation failure when neither declaration resolves.

Agent System never falls through to a host or repository Git identity. An empty
`git: {}` section is valid only when the agent section supplies both effective
values.

The active schema includes the signing fields defined below. Encrypted-key and
passphrase fields are not part of the schema.

## Tool Input and Execution

The model-facing input remains CLI-shaped:

```ts
interface AgentSystemGitInput {
  argv: string[];
  stdin?: string;
  cwd?: string;
}
```

The tool resolves one fixed, real `git` executable while excluding the
workspace bin, declared prepended paths, packaged bin, and the calling launcher
directory. It launches the absolute executable path without a shell, preserves
the child exit code, bounds input and output, applies cancellation and timeout
cleanup, and returns the shared structured tool result.

### Working directory

Git behavior depends on its current repository. `cwd` is therefore part of the
shared runner contract:

- native tool calls accept a workspace-relative `cwd` and default to `.`;
- the packaged shim preserves the caller's directory when it is inside the
  bound workspace;
- resolution verifies canonical paths and rejects symlink or parent traversal
  outside the workspace; and
- model arguments may not use `-C`, `--git-dir`, or `--work-tree` to bypass the
  validated working directory.

Managed worktrees remain planned. They default inside the agent workspace while
allowing an explicit operator-selected root. The semantic contract below uses
exact canonical admission and stable diagnostics rather than reopening `-C`,
`--git-dir`, or `--work-tree` as generic model arguments.

### Identity projection

Identity is projected only into the Git child. Agent System supplies:

```text
GIT_AUTHOR_NAME
GIT_AUTHOR_EMAIL
GIT_COMMITTER_NAME
GIT_COMMITTER_EMAIL
```

It also uses Git's command-scoped configuration environment to project
`user.name`, `user.email`, and `user.useConfigOnly=true`. The environment values
make author and committer identity authoritative, while command-scoped config
keeps ordinary reads such as `git config user.email` consistent. Agent System
does not run `git config --global`, write `.git/config`, or inherit the
operator's global identity.

### Noninteractive and configuration boundary

The tool establishes a conservative execution boundary:

- disable terminal credential prompts, pagers, editors, and browser launches;
- disable system and operator-global Git configuration;
- project `core.hooksPath` to the platform null path;
- clear credential helpers and selected executable configuration;
- reject model-supplied `-c`, `--config-env`, and `--exec-path` options;
- reject persistent Git configuration and credential-management mutations; and
- classify unknown subcommands before Git can discover arbitrary `git-*`
  executables.

Repository configuration remains a code-execution surface through helpers,
filters, external diff programs, aliases, and related options. The wrapper is
not a repository sandbox and must not claim that an untrusted checkout is safe.
Supported commands should neutralize known escape paths where Git provides a
command-scoped override, and the skill must keep this trust boundary explicit.

Agent System does not expose arbitrary Git configuration. It projects only the
command-scoped settings required for owned features such as identity, safety,
authentication, and signing. Any additional setting requires an explicit typed
product feature with corresponding policy, diagnostics, documentation, and
verification.

## Operation Policy

Git policy uses effect-specific selectors rather than inheriting the GitHub
provider's broad hazard classes:

| Field     | Values                 | Default | Covers                                                 |
| --------- | ---------------------- | ------- | ------------------------------------------------------ |
| `force`   | `allow`, `ask`, `deny` | `deny`  | Explicit safety overrides and forced ref replacement   |
| `rewrite` | `allow`, `ask`, `deny` | `deny`  | History replacement through rebase, amend, or reset    |
| `discard` | `allow`, `ask`, `deny` | `deny`  | Loss of working-tree, index, untracked, or stash state |
| `delete`  | `allow`, `ask`, `deny` | `deny`  | Ref, worktree, reflog, or unreachable-object deletion  |
| `unknown` | `allow`, `ask`, `deny` | `deny`  | Aliases, undeclared helpers, or unsupported syntax     |

Recognized reads and ordinary writes are allowed. Hazard selectors take
precedence over the command's ordinary behavior and accumulate when an
invocation has several effects. Every selected policy must allow the operation:
a force push selects `force` and `rewrite`; `reset --hard` selects `rewrite` and
`discard`; a forced worktree removal selects `force`, `discard`, and `delete`.

Ambiguous `checkout` forms select `discard`; callers use `switch` for branches
and `restore` for paths when they need precise policy. Supported public Git
command families are classified as reads, ordinary writes, or selected hazards;
unsupported internal and plumbing syntax remains fail-closed.

`git.extensions` is an exact mapping from external helper names to `allow`,
`ask`, or `deny`. A `town` declaration applies only when `git-town` resolves as
an executable on the effective process `PATH`, so repository aliases do not
qualify. Built-in command and hazard classification always takes precedence.
Agent System also masks each declared alias name through command-scoped
configuration so a missing helper cannot fall back to repository alias content.
The selected extension decision applies to the helper's complete private
argument surface. Commands without an exact declaration retain the `unknown`
decision, which may still explicitly allow the broad alias and helper surface.

`ask` is available only to native `agent_system_git` calls with an originating
OpenClaw approval conversation. Direct CLI and shim invocations reject an ask
decision. Policy is applied before environment resolution or any SSH
authentication or signing-key materialization.

The classifier remains selector-first and recognizes stable public command
families rather than mirroring Git's versioned internal command tree. Tests own
every recognized hazard, ordinary public family, extension boundary, and
credential or executable escape hatch.

## SSH Authentication

SSH authentication uses explicit source objects so Agent System never guesses
whether a string is a path, environment binding, or another value:

```yaml
git:
  ssh:
    private-keys:
      - path: ~/.ssh/id_ed25519
      - from-environment: GIT_SSH_PRIVATE_KEY
```

`private-keys` accepts one source or an ordered list. Every object contains
exactly one source:

- `path` selects an existing private-key file. Relative paths resolve from the
  workspace; absolute and `~/` paths are explicit operator declarations. Agent
  System validates a non-symlinked regular file with private ownership and
  permissions, loads it without modifying it, and does not copy it into the
  workspace.
- `from-environment` names one value in the completed Agent System environment
  that contains OpenSSH private-key material. The completed environment may
  receive that value from literals, dotenv, a declared 1Password Environment,
  or an `environment.set` `from-op` reference. Git does not duplicate the shared
  direct-secret resolver in its own schema.

Managed authentication requires `ssh`, `ssh-agent`, and `ssh-add` from OpenSSH.
The source-development Brewfile installs the Homebrew `openssh`
formula. Installed hosts remain responsible for providing these executables;
the authentication slice adds stable readiness diagnostics rather than falling
back to ambient SSH agents or identities.

### Credential-resource lease

Private-key support uses the shared invocation-scoped resource contract. The
tool runtime must be able to acquire child environment and a finalizer, then run
preflight and main execution inside `try/finally` so cleanup occurs after
success, failure, timeout, cancellation, or partial preparation.

The shared runtime contract is:

```ts
interface AgentSystemToolResourceLease {
  environment?: Readonly<Record<string, string>>;
  sensitiveValues?: readonly string[];
  dispose(): Promise<void>;
}
```

The Git implementation starts an isolated authentication `ssh-agent` in an
owner-only temporary socket directory for every authorized invocation with
managed authentication configured. It loads only the declared authentication
keys and projects the fixed `GIT_SSH` helper for the complete invocation. Git
decides whether an operation actually needs that helper. The Git child receives
no generic `SSH_AUTH_SOCK`; the helper uses a private SSH configuration whose
`IdentityAgent` and `IdentityFile` selectors admit only the declared
authentication identities. Agent System kills and waits for the agent before
removing its socket directory. Raw private-key values never enter Git arguments,
child environment, logs, audit, errors, or returned output.

OpenSSH loads raw completed-environment key material through `ssh-add` standard
input, so Agent System does not create a private-key file for that source. Path
sources continue to read the operator-declared file without copying it.

The 1Password desktop SSH agent may be supported later as an explicit
workstation mode where private key material never leaves 1Password. It is not
the headless default because it requires a desktop session and user approval.
The headless path uses the stored service-account credential to resolve the
declared item only after authorization.

The authentication contract supports unencrypted source material and returns a
stable noninteractive error for encrypted or locked keys. Passphrase bindings
and an owner-controlled askpass channel remain deferred until the product owns
a safe IPC design. Any future passphrase support must keep the secret out of
arguments, Git's child environment, logs, audit, errors, and results.

## SSH Commit and Tag Signing

SSH signing reuses the credential-resource lease:

```yaml
environment:
  set:
    GIT_SIGNING_KEY:
      from-op: 'op://vault-id/item-id/private key?ssh-format=openssh'

git:
  signing:
    key: GIT_SIGNING_KEY
    allowed-signers-file: .agent-system/allowed_signers
```

The presence of `git.signing` enables SSH signing for every commit and tag. The
manifest does not expose `format`, `enabled`, `commits`, or `tags` switches:
absence disables managed signing and presence selects one complete signing
contract. Agent System supports only the SSH signature format and does not add
OpenPGP or X.509 key sources.

`key` is an environment binding: its scalar value names one variable in the
completed Agent System environment and can never contain private-key material.
Unlike authentication keys, signing does not accept filesystem paths or source
arrays. For every authorized invocation with signing configured, Agent System
loads the private key into a dedicated isolated signing agent and projects only
command-scoped Git settings:

```text
gpg.format=ssh
commit.gpgSign=true
tag.gpgSign=true
gpg.ssh.defaultKeyCommand=<agent-system-signing-key-helper>
gpg.ssh.program=<agent-system-ssh-keygen-helper>
```

Git calls `gpg.ssh.defaultKeyCommand` only when a signature needs a dynamic
public-key selection and calls `gpg.ssh.program` when it signs or verifies. Each
helper selects the dedicated signing socket only for its own process; the Git
child receives no generic `SSH_AUTH_SOCK`. Agent System therefore does not
classify commands to predict signing behavior, and nested Git calls or declared
extensions inherit the same durable helper contract. Model-supplied
signing-control flags, including flags that disable signing or select an
alternate key, are configuration escape hatches and fail before environment or
key resolution.

Authentication and signing remain independently configurable and use separate
agents even when the operator selects the same underlying key. The signing
socket is not visible through `SSH_AUTH_SOCK`, so transport cannot automatically
offer a signing key for authentication. The managed SSH configuration continues
to select only declared authentication identities.

### Allowed signers and local verification

`allowed-signers-file` is optional and names one literal workspace-relative
file. Manifest validation rejects absolute, empty, and escaping declarations.
Runtime inspection and execution require a canonical, regular, non-symlinked
file inside the workspace. The file is public trust policy rather than a
credential, so Agent System neither resolves it through the environment nor
generates or mutates it.

When configured, Agent System projects the canonical path through
`gpg.ssh.allowedSignersFile` and requires fully trusted verification through
`gpg.minTrustLevel=fully`. The file may retain current and rotated signer keys,
validity windows, collaborator keys, or SSH certificate authorities using the
OpenSSH allowed-signers format. Commands such as `git log --show-signature`,
`git verify-commit`, and `git verify-tag` can therefore verify trusted SSH
signatures through the same fixed signing-program helper.

A repository-owned allowed-signers file is trustworthy only when changes to
that file are themselves protected. Agent System documents that boundary and
does not describe a key as trusted merely because an untrusted checkout added
it. When the field is absent, signing still works and hosting providers may
verify registered keys, but local Git verification has no Agent System-managed
trust store.

GitHub registration of the public authentication or signing key remains owned
by `github.ssh-keys` and `github.ssh-signing-keys`; the Git tool does not mutate
a hosting provider.

## Remaining Git Work

### Explicitly allowed worktrees

Worktree support remains part of the Git capability. It does not add a generic
top-level Worktree capability, interpret GitHub issues, receive provider
notifications, select an agent, or create Codex tasks or OpenClaw sessions. A
narrow semantic worktree tool may be registered alongside `agent_system_git`
when a separate typed input is clearer than extending the CLI-shaped schema;
both surfaces retain the same `git` manifest capability, policy, identity,
runner, audit, documentation, and verification owner.

#### Work identity and external handoff

The durable unit is a repository work item rather than a conversation. An
external controller provides:

```ts
interface AgentSystemGitWorktreeRequest {
  action: 'prepare' | 'inspect' | 'list' | 'attach' | 'remove';
  repository?: {
    id: string;
    cloneUrl?: string;
  };
  workId?: string;
  label?: string;
  baseRef?: string;
  branch?: string;
}
```

The final schema may use action-specific objects instead of optional fields, but
it preserves these semantics:

- `repository.id` is a bounded stable selector for either a configured local
  repository override or an Agent-System-managed repository clone;
- `repository.cloneUrl` is optional untrusted onboarding input. Agent System
  accepts any supported network Git remote without a host, owner, or repository
  allowlist, but parses it as one fixed Git argument and rejects local-path,
  `file:` transport, option-like, control-character, and shell-fragment forms;
- `workId` is one bounded opaque stable identifier. Agent System does not parse
  provider, repository, issue, or organization semantics from it;
- `label` is untrusted display input and is sanitized, length-bounded, and
  combined with a short work-id digest before it contributes to a path or
  default branch;
- `baseRef` is an explicit existing local ref selected for a new worktree; and
- `branch` is optional so external orchestration may apply organization-specific
  naming while Agent System retains a neutral collision-resistant fallback.

`prepare` returns the canonical repository, branch, worktree path, work id, and
`created` or `existing` status. Repeating the same repository and work id is
idempotent. A later label or base-ref change does not relocate or recreate an
existing worktree. A changed repository or explicitly incompatible branch for
an existing work id is a conflict rather than a second checkout. One worktree
may attach to several conversations over time, while one conversation has at
most one active worktree in the initial implementation.

GitHub assignment monitoring, job claims, repository-slug catalogs, account and
agent selection, friendly session titles, Codex task creation, OpenClaw session
creation, and issue or pull-request completion are external orchestration. A
future typed cross-plugin capability may carry this handoff after an external
consumer proves the supported OpenClaw SDK boundary; Agent System does not add a
private service locator or notification implementation for the first slice.

#### Declaration and local state

The manifest declares only operator-owned worktree configuration and policy. It
does not list active jobs. The minimal declaration enables workspace-local
defaults:

```yaml
git:
  worktrees: {}
```

The expanded shape is:

```yaml
git:
  worktrees:
    # optional; defaults to .agent-system/worktrees
    root: .agent-system/worktrees

    repositories:
      # optional; defaults to .agent-system/repositories
      root: .agent-system/repositories

      # optional existing local repository overrides by stable repository id
      local:
        agent-system: ~/tanaab/openclaw-agent-system
        canon: ~/tanaab/canon
```

The worktree root and managed-repository root belong to the installed agent and
default inside its workspace so users can inspect agent work without locating a
separate hidden state tree. Managed repositories are bare clones keyed by the
bounded repository id. A preparation request may onboard a missing repository
into that root from its validated `cloneUrl`; there is no repository allowlist.
Once stored, the repository id and normalized source form immutable provenance:
a later request cannot silently retarget the id. Clone and fetch reuse the Git
tool's policy, invocation-scoped authentication, fixed executable, and redaction
boundaries.

`repositories.local` maps a repository id to an existing operator-selected Git
repository. A relative path resolves from the agent workspace; absolute and
home-relative paths are allowed only from manifest desired state. The canonical
path must name a real non-symlinked repository. A configured local override is
authoritative: if it is missing, unsafe, or no longer a Git repository, the
operation fails instead of silently switching to a managed clone.

Custom roots are optional. Workspace-relative roots must remain canonically
inside the workspace, real, non-symlinked, ignored, and untracked. During
`install`, Agent System creates or reconciles the roots and idempotently appends
a clearly labeled block to the workspace `.gitignore` while preserving existing
content and file mode:

```gitignore
# agent system managed git workspaces.
.agent-system/repositories/
.agent-system/worktrees/
```

Install fails closed when a managed path is already tracked, resolves through a
symlink, or cannot be made effectively ignored. An explicit root outside the
workspace is not added to the workspace `.gitignore` and requires the same
canonical ownership and permission checks before state admits it.

The ignored workspace-local directories remain intentionally visible for
direct inspection in editors that do not hide ignored files. Agent System does
not write `.vscode/settings.json`: repository discovery, file watching, and
third-party language-server exclusions have different usability tradeoffs and
remain optional editor configuration rather than portable product state.

Active mappings live in an owner-only, atomic Agent System state store. Each
record includes the agent, repository id, managed clone provenance when
applicable, opaque work id, canonical repository and Git common directory,
canonical worktree path, branch, base ref when known, attached trusted session
keys, and lifecycle status. The store is binding and recovery metadata rather
than a substitute for Git. Inspection reconciles it with
`git worktree list --porcelain`, and per-repository locking serializes clone,
fetch, prepare, attach, and removal races.

#### Path admission and command routing

Model input never supplies an arbitrary worktree destination. Agent System
derives the path beneath the configured root from the approved repository,
sanitized label, and work-id digest, validates the existing canonical parent
before creation, and verifies the created path, Git common directory, and
worktree registration afterward. Symlink, parent, absolute-path, path-alias, and
case-collision escapes fail closed.

A managed directory becomes a valid Git `cwd` only after its exact canonical
worktree root is active in the state store. The runner admits that root and its
real descendants, not the configured root generally. This exact registration
check applies even when the configured root is already inside the agent
workspace. `-C`, `--git-dir`, and `--work-tree` remain unavailable. Direct
command and packaged-shim invocations started inside an admitted worktree
resolve the owning installed agent and workspace through the state record;
Agent System never copies `agent.yaml` into the worktree or relies on upward
manifest discovery outside the bound workspace.

Until this operand-aware admission exists, raw `git worktree` permits only
read-only `list`; `add`, `move`, `remove`, `repair`, `lock`, `unlock`, `prune`,
and unknown subcommands fail validation even when their process `cwd` is inside
the workspace. Semantic worktree operations build a fixed Git argument array
internally and do not route typed fields back through model-controlled raw
arguments.

#### Session attachment and execution surfaces

A trusted OpenClaw tool context may attach its stable session key to an existing
work id or to a successfully prepared worktree. The session key is correlation
metadata, not the work id or a deletion lease. Session reset, compaction, end,
or replacement never removes or recreates the worktree.

When a session has one active attachment, `agent_system_git` defaults to that
worktree and reports the effective work context through non-secret tool output,
guidance, and audit. An explicit `cwd` must still resolve within the agent
workspace or the attached admitted worktree. Agent System does not claim that
the binding changes generic OpenClaw exec, Codex native execution, ACP, MCP,
node-host, plugin-defined, sandbox, or remote working directories; every such
surface needs its own supported adapter and proof.

#### Policy, removal, and recovery

`prepare` and `attach` are ordinary writes after their repository and paths are
validated. Initial clone and later fetch are part of preparation and remain
ordinary writes after policy and remote syntax validation. Preparation never
pushes. A later push runs only through the existing Git tool, which applies its
normal push, force, rewrite, credential, and approval boundaries; hosting-side
permissions and protected-branch rules remain the final remote authorization.
An ordinary push to an unprotected branch remains allowed unless a future Git
push-specific policy says otherwise.
`inspect` and `list` are reads. Physical worktree removal selects `delete`; a
forced removal additionally selects `force` and `discard` and keeps the existing
approval requirements. The initial semantic removal refuses dirty or missing
worktrees and does not offer force, delete the branch, delete a ref, or prune
unreachable objects. Those remain separate explicit Git operations.

Conversation termination never triggers removal. External orchestration may
request removal when its job is terminal, but Agent System independently checks
the record, canonical path, Git registration, working-tree cleanliness, and
policy before mutation. Failed removal preserves enough state for inspection
and retry. `doctor` reports missing roots, unsafe permissions, symlink or
containment drift, duplicate or conflicting work ids, missing repositories,
stale Git registrations, moved or absent worktrees, unknown worktrees under the
managed root, and state records whose agent or session binding cannot be
resolved. Read-only inspection never prunes or repairs automatically.

Deleting the whole agent workspace intentionally deletes its owned managed
repositories, worktrees, and binding state. Likewise, an operator bypassing the
Git wrapper with an ignored-file-inclusive `git clean` can make those paths
eligible for deletion. That is an ownership and recovery property, not a reason
to project them into global state; normal Agent System Git policy continues to
deny non-dry-run `git clean` as `discard` by default.

#### Delivery sequence

1. Block raw path-mutating worktree forms and add focused policy and validation
   tests for the temporary fail-closed boundary.
2. Add workspace-local default roots, managed `.gitignore` reconciliation,
   local repository overrides, unrestricted supported-remote clone onboarding,
   path derivation, the owner-only state store, and repository locking.
3. Implement the semantic service and operator CLI with idempotent clone and
   `prepare`, `inspect`, `list`, and non-forced `remove`.
4. Admit registered worktrees in the shared working-directory resolver and add
   command/shim owner lookup from an admitted worktree.
5. Add trusted OpenClaw `attach`, session-aware Git defaults, context reporting,
   and audit correlation without making sessions own worktree lifetime.
6. Add lifecycle validation, `doctor`, stale-state diagnostics, documentation,
   and focused direct tests.
7. Extend the existing Git Leia scenario and matrix entry to prove installed
   preparation, session attachment, Git execution in the worktree, restart or
   reattachment, and explicit clean removal. Do not run that scenario locally.

## Verification Contract

The Git implementation must directly verify:

- static schema, manifest, tool, registration, guidance, and launcher agreement;
- literal, environment-resolved, and agent-fallback identity;
- stable failure when effective name or email is unavailable;
- no global, repository, or Gateway identity mutation;
- workspace and symlink containment for the effective working directory;
- fixed executable resolution without launcher recursion;
- argument, configuration, helper, and credential escape-hatch rejection;
- force, rewrite, discard, delete, and unknown policy before environment or key
  resolution;
- bounded child input/output, cancellation, timeout, and process-tree cleanup;
- raw private-key values absent from schemas, arguments, Git child environment,
  logs, audit, errors, and results; and
- credential-resource cleanup on every terminal path.

The worktree implementation additionally verifies:

- raw worktree mutation fails closed until the semantic service validates every
  repository, ref, destination, and registered worktree operand;
- opaque work-id idempotency, sanitized collision-resistant path and branch
  derivation, changed-label stability, and conflicting binding rejection;
- workspace-local default roots, idempotent managed-ignore reconciliation,
  tracked-path and symlink rejection, and no automatic `.vscode` mutation;
- stable repository-id selection, local-override precedence and failure,
  supported network remotes without a repository allowlist, immutable clone
  provenance, managed bare-clone idempotency, and rejection of local-path,
  option-like, control-character, shell-fragment, or conflicting clone sources;
- canonical repository, root, worktree, descendant, Git common-directory,
  symlink, path-alias, case-collision, and command/shim owner resolution;
- atomic owner-only state, per-repository concurrency, partial-create cleanup,
  Git-registration reconciliation, and value-free stale-state diagnostics;
- trusted session attachment, session replacement and reattachment, one active
  worktree per initial conversation, and no session-triggered deletion;
- read, write, delete, force, and discard policy before Git or filesystem
  mutation; and
- dirty, missing, moved, unknown, conflicting, and clean removable worktrees
  retain the documented non-forced recovery behavior.

The signing implementation additionally verifies:

- the presence of `git.signing` signs every supported commit- and tag-producing
  operation with SSH and no per-kind toggle;
- the selected public key matches the configured private signing key;
- configured authentication and signing resources are prepared for every
  authorized Git invocation without command-use classification;
- Git selects the fixed authentication, signing-key, and signing-program helpers
  only when their official integration points are needed;
- authentication and signing use distinct agents and neither socket is exposed
  to the Git child through `SSH_AUTH_SOCK`;
- signing-disable and alternate-key escape hatches fail before credential
  resolution;
- an allowed-signers file distinguishes trusted, untrusted, invalid, and
  unsigned objects independently of private signing-key selection; and
- signing keys and derived sensitive material remain absent from Git arguments,
  child environment, logs, audit, errors, and results.

The Git Leia scenario proves the installed package, shim, shared runtime,
identity fallback, real local `git` invocation, resulting author and committer
identity, OpenSSH readiness, and isolated SSH authentication against GitHub on
macOS and Ubuntu. Resolver variants and containment edge cases remain direct
unit tests. The scenario includes one signed commit, one signed tag, and local
verification through a checked-in public allowed-signers fixture; signing does
not add a second scenario solely for the same runtime boundary.

## Deferred Decisions

- Which owner-controlled IPC mechanism should deliver passphrases to a
  noninteractive askpass adapter if encrypted keys are later supported.
- Whether the 1Password desktop SSH agent should become a declared workstation
  mode.
- Which additional Git operations need semantic convenience tools beyond the
  generic CLI-shaped surface.

## References

- [Git environment variables](https://git-scm.com/docs/git)
- [Git configuration](https://git-scm.com/docs/git-config)
- [Git hooks](https://git-scm.com/docs/githooks)
- [Git credentials](https://git-scm.com/docs/gitcredentials)
- [1Password SSH agent](https://www.1password.dev/ssh/agent)
- [1Password Git commit signing](https://www.1password.dev/ssh/git-commit-signing)
- [1Password CLI secret references](https://www.1password.dev/cli/secret-references)
- [OpenSSH ssh-agent](https://man.openbsd.org/ssh-agent.1)
- [OpenSSH ssh-add](https://man.openbsd.org/ssh-add.1)
