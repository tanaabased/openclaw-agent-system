# Agent System Git Tool Specification

## Status

This document defines the Agent System Git tool. It owns Git-specific
configuration, execution, policy, SSH authentication, signing, documentation,
and verification decisions. The root [product specification](../../SPEC.md)
owns the shared environment, tool-runtime, lifecycle, and security contracts.

The first implementation slice ships the tool scaffold, agent identity
projection, working-directory containment, policy, and direct verification.
The SSH runtime foundation adds invocation-scoped resource cleanup and a
cross-platform OpenSSH compatibility proof. The first authentication slice
adds unencrypted path and completed-environment key sources through an isolated
per-invocation SSH agent. Generic direct OP environment values now provide the
1Password-backed authentication path without adding a Git-specific secret
source. Encrypted keys and signing build on that foundation.

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

The initial identity surface is:

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

Future encrypted-key and signing fields are defined below but must not be added
to the manifest schema until their owning runtime behavior exists.

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

Git behavior depends on its current repository. `cwd` is therefore a shared
runner capability required by the first Git slice:

- native tool calls accept a workspace-relative `cwd` and default to `.`;
- the packaged shim preserves the caller's directory when it is inside the
  bound workspace;
- resolution verifies canonical paths and rejects symlink or parent traversal
  outside the workspace; and
- model arguments may not use `-C`, `--git-dir`, or `--work-tree` to bypass the
  validated working directory.

Explicit operator-selected worktrees outside the workspace remain deferred
until the product defines an owned allowlist and diagnostic model.

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

The first implementation establishes a conservative execution boundary:

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
decision. Policy is applied before environment resolution or future SSH-key
materialization.

The classifier remains selector-first and recognizes stable public command
families rather than mirroring Git's versioned internal command tree. Tests own
every recognized hazard, ordinary public family, extension boundary, and
credential or executable escape hatch.

## SSH Authentication

SSH authentication is the second Git delivery slice. It uses explicit source
objects so Agent System never guesses whether a string is a path, environment
binding, or another value:

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

Private-key support requires a shared invocation-scoped resource contract. The
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

The Git implementation starts one isolated `ssh-agent` in an owner-only
temporary socket directory, loads only the selected keys, gives Git only
`SSH_AUTH_SOCK`, and kills and waits for the agent before removing its socket
directory. Raw private-key values never enter Git arguments, child environment,
logs, audit, errors, or returned output.

The completed macOS and Ubuntu compatibility proof established that OpenSSH can
load raw completed-environment key material through `ssh-add` standard input.
Agent System therefore does not create a private-key file for that source.
Path sources continue to read the operator-declared file without copying it.

The 1Password desktop SSH agent may be supported later as an explicit
workstation mode where private key material never leaves 1Password. It is not
the headless default because it requires a desktop session and user approval.
The headless path uses the stored service-account credential to resolve the
declared item only after authorization.

The initial authentication slice supports unencrypted source material and
returns a stable noninteractive error for encrypted or locked keys. A later SSH
authentication slice adds explicit passphrase bindings and an owner-controlled
askpass channel without passing the secret through arguments or Git's child
environment.

## SSH Commit Signing

SSH signing is the third Git delivery slice and reuses the credential-resource
lease:

```yaml
environment:
  set:
    GIT_SIGNING_KEY:
      from-op: 'op://vault-id/item-id/private key?ssh-format=openssh'

git:
  signing:
    key:
      from-environment: GIT_SIGNING_KEY
    commits: true
    tags: false
```

The signing key accepts the same source union as authentication keys. Agent
System loads it into the isolated agent, determines its matching public key, and
projects only command-scoped Git settings:

```text
gpg.format=ssh
user.signingKey=key::<public-key>
commit.gpgSign=true|false
tag.gpgSign=true|false
```

Authentication and signing remain independently configurable even when an
operator selects the same underlying key. GitHub registration of the public
authentication or signing key remains owned by `github.ssh-keys` and
`github.ssh-signing-keys`; the Git tool does not mutate a hosting provider.

## Additional Git Configuration

Later versions may add a closed allowlist of declarative settings with safe
defaults, such as:

- `init.defaultBranch`;
- `pull.rebase`;
- `fetch.prune`; and
- `push.default`.

The manifest does not expose an arbitrary Git configuration map. Arbitrary
configuration would reintroduce executable helpers, filters, aliases, hooks,
and path escape hatches through a trusted configuration projection.

## Documentation, Skill, and Visual Identity

The implementation slice creates `tools/git/README.md` using the same compact
order as the GitHub tool README: overview, requirements, configuration
reference, CLI, shim, and further reading. The root README and `ADVANCED.md`
link to that tool-owned guide instead of duplicating its full contract.

`skills/git-cli/SKILL.md` tells agents to prefer `agent_system_git` for local
working-tree, branch, commit, fetch, and push work, while routing GitHub provider
work to `agent_system_github`. Its OpenClaw metadata uses the `🌿` emoji.

The Codex metadata in `skills/git-cli/agents/openai.yaml` references small and
large SVG assets under `skills/git-cli/agents/assets/`, uses the Agent System
brand color `#00c88a`, and supplies a short default prompt. The assets are
derived from the official one-color Git logomark SVG, recolored to the Tanaab
brand color, in the same presentation pattern as the GitHub tool's Octocat.
The tool README retains the required upstream attribution for the Git logo's
Creative Commons Attribution 3.0 license.

Official asset source:
<https://git-scm.com/images/logos/downloads/Git-Icon-Black.svg>

## Delivery Plan

### Slice 0: specification split (complete)

- Create this tool-owned specification.
- Reduce the root specification to shared architecture, invariants, and links
  to first-party tool specifications and documentation.
- Remove completed implementation checklists and duplicated GitHub behavior
  from the root specification without removing durable shared contracts.

### Slice 1: scaffold and identity (complete)

- Add the static manifest and model-input schemas, tool definition, policy,
  registration, guidance, CLI bridge, packaged shim, skill, icon assets, and
  README.
- Add effective name and email resolution with agent fallbacks.
- Add workspace-contained working-directory support to the shared runner.
- Project process-local identity and noninteractive Git configuration.
- Add compact Git-specific hazard and unknown classification.
- Add focused unit tests and one minimal matrix-backed `examples/git` Leia
  scenario.

### Slice 2A: SSH runtime foundation (complete)

- Add OpenSSH to the source-development Brewfile.
- Add the credential-resource lease to the shared runtime with guaranteed
  cleanup tests.
- Complete the macOS and Ubuntu raw-key loading compatibility spike.
- Keep SSH manifest configuration unavailable until the runtime foundation is
  proven.
- The temporary `test:openssh` spike scaffolding was removed after the Slice
  2B1 `examples/git` Leia scenario proved managed SSH authentication on macOS
  and Ubuntu.

### Slice 2B1: unencrypted SSH authentication (complete)

- Add path and completed-environment key sources.
- Start and clean up one isolated SSH agent per invocation.
- Add source validation, readiness diagnostics, unit tests, and a narrowly
  focused SSH assertion to the existing Git Leia scenario.

### Slice 2B2: 1Password-backed SSH authentication (complete)

- Add shared `environment.set` `from-op` resolution for declared secret
  references after credential access is established.
- Feed the resolved value to Git through its existing `from-environment` source
  instead of adding a Git-specific resolver.
- Prove a real vault key and a distinct environment-provided key in the existing
  Git Leia scenario.

### Slice 2C: encrypted SSH keys

- Add environment and 1Password passphrase bindings without literal secret
  values.
- Provide passphrases through an owner-controlled noninteractive askpass
  channel.
- Keep passphrases out of arguments, Git's child environment, logs, audit,
  errors, and results.

### Slice 3: SSH signing

- Add signing configuration and public-key resolution.
- Project SSH signing settings into only the Git child.
- Add commit and tag signing tests without coupling provider registration to
  local Git execution.

### Slice 4: constrained configuration expansion

- Add only proven, schema-owned Git settings.
- Expand doctor and policy classification where real usage or failures justify
  it.
- Keep each additional Leia scenario focused on one runtime boundary.

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

The Git Leia scenario proves the installed package, shim, shared runtime,
identity fallback, real local `git` invocation, resulting author and committer
identity, OpenSSH readiness, and isolated SSH authentication against GitHub on
macOS and Ubuntu. Resolver variants and containment edge cases remain direct
unit tests.

## Deferred Decisions

- Which owner-controlled IPC mechanism should deliver passphrases to a
  noninteractive askpass adapter.
- Whether the 1Password desktop SSH agent should become a declared workstation
  mode.
- Whether explicitly approved worktrees outside the agent workspace need a
  durable allowlist.
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
- [Official Git logos](https://git-scm.com/community/logos)
