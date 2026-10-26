# Skill Authoring

## Scope

- apply this guidance to every skill in this directory and to changes in its discovery metadata or runtime references. keep each skill's execution instructions in its own `SKILL.md`.
- use the shared Skill Author contract with public namespace `agent-system` and container `openclaw-plugin`. pass `--namespace agent-system --container openclaw-plugin` explicitly to its scripts.

## Terminology

- use **task** for the work being assessed, implemented, or reported, and **managed task** when Agent System tracks its native workflow. task does not mean only GitHub's Task issue type.
- use **GitHub issue** for the provider object: its URL, number, assignment, comments, or open/closed state. introduce the relationship as a task tracked by a GitHub issue when needed. preserve exact provider terms in API fields, configuration keys, commands, diagnostics, and examples.
- use **chat** for the operator-facing conversation. use **session** or **thread** for exact runtime concepts and APIs. opening a new Codex chat does not create or select a new task.
- keep **assessment**, **implementation**, and **delivery** distinct. a recorded plan, completed implementation, and published PR establish different outcomes. preserve direct-entry restrictions and managed host handoffs.
- **retirement** ends managed task work and attempts eligible native cleanup; it does not mean closing or unassigning the GitHub issue, deleting its branch, or erasing retained task history.
- retain Git, GitHub, Google, Codex, OpenClaw, pull request, repository, worktree, and other concrete product or technical terms where they identify the actual surface. do not replace every occurrence of issue with task.

## Names and Metadata

- name task workflows `task-<operation>`, such as `task-launch`, `task-assessment`, `task-implementation`, `task-update`, and `task-retirement`. use provider or capability names for their own operations, such as `github-reply`, `git-cli`, and `model-routing`. retain established command names such as `doctor` and `install`.
- keep one identity across the folder, frontmatter, heading, interface, homepage, and invocation: `skills/task-assessment/`, `agent-system-task-assessment`, `Agent System Task Assessment`, and `$agent-system-task-assessment`. qualified host references use `agent-system:agent-system-task-assessment` where required.
- use `Agent System <Surface>` for both the `SKILL.md` heading and `interface.display_name`. preserve technical casing, including `Git CLI`, `GitHub CLI`, and `Google CLI`.
- start descriptions with the action and outcome. state when the skill applies and any consequential boundary; avoid boilerplate such as "Agent System guidance for". task skill descriptions must identify their GitHub-backed scope without making issue the domain name.
- make `interface.short_description` a concise outcome, not a list of internal mechanisms. make `interface.default_prompt` an operator request that invokes the exact skill ID; keep procedural and recovery instructions in `SKILL.md`.
- retain `metadata.owner: tanaab` as Canon provenance. choose `metadata.type` from the skill's actual contract, independently of its name or category. tags contain the owner, type, and a meaningful category; use `task-management` for task workflows and `operations` for notification reset, not another type or `validation` as their category.
- keep natural-language selection phrases and adjacent-skill exclusions in the skill's description and `When to Use` / `When Not to Use` sections. authoring guidance alone is not an invocation alias or an execution grant.

## Presentation Assets

- give every skill a surface-specific `metadata.openclaw.emoji` and HTTPS source homepage in `SKILL.md`. keep OpenClaw metadata there rather than duplicating it in `agents/openai.yaml`.
- give every skill complete OpenAI interface metadata: display name, short description, default prompt, brand color, and valid local small and large icon assets.
- keep icons single-color transparent SVGs, with consistent visual weight and padding. use capability or provider marks rather than Tanaab wordmarks or framed tiles; do not add background circles, gradients, shadows, or separate theme variants.
- color skills by their primary role using the three groups below. use the same exact color in both icon sizes and `interface.brand_color`. these are presentation groups, independent of `metadata.type`, tags, and runtime authority.

| Group           | Color           | Skills                                                                                    |
| --------------- | --------------- | ----------------------------------------------------------------------------------------- |
| tools           | green `#00c88a` | `git-cli`, `github-cli`, `google-cli`, `git-worktree`, `install`, `doctor`                |
| task management | pink `#db2777`  | `task-launch`, `task-assessment`, `task-implementation`, `task-update`, `task-retirement` |
| support         | blue `#387fb5`  | `codex-binding`, `model-routing`, `github-reply`, `notifications-reset`                   |

- place CLI and native tool operation skills in tools, skills that own an individual task's lifecycle in task management, and reusable configuration, routing, composition, or workspace maintenance skills in support. add future skills to the matching group rather than introducing a color for each workflow stage.
- keep plugin-level icons and branding separate from this skill palette. a color-only change preserves existing icon geometry, sizing, and transparency.

## Identity Changes and Verification

- update a renamed skill's folder, identity metadata, links, runtime defaults, native discovery references, maintained configuration examples, and owning package/discovery checks together. keep provider schemas and runtime operation names unchanged unless separately required.
- do not rewrite historical changelog entries, submitted requests, retained source snapshots, or task journals to make them appear to have used a new skill. explicit external skill selections need an identified configuration update; a rename never authorizes silent fallback to another skill.
- preserve distinct skill boundaries and authorization. do not turn launch into direct implementation, retirement into general deletion, or reply composition into permission to publish.
- validate changed skills through Skill Author, inspect manual findings, check links and remaining old identities, and run the relevant repository checks. packaging and native discovery need their owning checks when names or paths change; do not add tests that merely freeze prose.
- follow the root guidance for cache synchronization and fresh native discovery. report structural validation, native discovery, and live workflow behavior as separate evidence.
