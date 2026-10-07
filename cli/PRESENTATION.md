# CLI Presentation

This is the authoring contract for Agent System-owned terminal output. Apply it
before adding or changing a command, table, setup preview, or diagnostic.

## Palette

Use `createCliStyles` in `cli/output.ts`; callers must not define ANSI escapes or
private palettes. Brand hues follow [Tanaab Theme](https://github.com/tanaabased/theme/blob/main/styles/vars.scss).
Semantic colors use the terminal's own ANSI palette so they match its theme.

| Role                      | Style     | Color                         |
| ------------------------- | --------- | ----------------------------- |
| Actions and host setup    | `action`  | Tanaab green `#00c88a`        |
| Targets and destinations  | `target`  | Tanaab pink `#db2777`         |
| Agent setup accent        | `accent`  | Tanaab light pink `#e25292`   |
| Success                   | `status`  | Terminal green                |
| Warning and drift         | `warning` | Terminal yellow               |
| Failure                   | `error`   | Terminal red                  |
| Information               | `notice`  | Terminal cyan                 |
| Supporting detail         | `field`   | Dim terminal foreground       |
| Manual and skipped status | `field`   | Dim terminal foreground       |
| Section titles            | `bold`    | Uncolored terminal foreground |

Color labels, statuses, and focal targets—not entire explanations. Healthy and
unchanged explanations are quiet; attention rows remain readable and emphasize
their component and status. Never force a terminal background. Respect color
detection, `NO_COLOR` precedence, and `FORCE_COLOR`; no-color output retains the
same content and layout.

## Spacing

- Keep result tables flush left with a blank line above and below. Use two
  spaces between aligned columns, measuring terminal cells rather than string
  length. Do not indent the whole table as though it were a nested list.
- Separate logical rows with a blank line; keep wrapped lines within a row
  together. Keep the workspace footer flush left and precede it with a blank
  line. Doctor displays attention first; Install preserves operation order.
- Separate setup steps with a blank line, indent step labels by two spaces and
  check/apply details by four. Preserve full commands, timeouts, and step order.
- Separate message blocks with a blank line. Indent message bodies by two spaces.
- Wrap without losing words or literal command details. Stack table explanations
  at narrow widths; reduce indentation when necessary to keep content visible.

## One Diagnostic Section

Wrap command implementations with `presentCliCommand` in `cli/presentation.ts`.
Manifest and operation helpers submit structured notices through
`writeCliDiagnosticNotices` (or `writeCliError`); they must not write diagnostics
directly to stdout/stderr. Nested helpers join the same command collector.

The presenter emits one **Messages** section on stderr after primary output,
including the table and workspace footer when available. It collects information,
warnings, errors, and recovery guidance together on success, early return,
cancellation, and failure. An empty collection produces no section. An early
failure without a result table still displays its messages. Do not suppress or
change severity to make output look healthy.

Interactive consent previews and prompts stay before mutation; they are not
diagnostic sections. Child-tool stdout/stderr remain pass-through streams, and
OpenClaw-owned help, logs, and prompt internals remain host-owned.

JSON stdout contains only the existing structured result. Diagnostics remain
plain stderr text without headings or ANSI; preserve codes, values, and exit
status. Styling must not change authorization, confirmation defaults, or actions.

## Verification

Capture stdout and stderr in one ordered event list. Check that manifest and
operation messages appear after primary output in one section, including partial
failure and declined consent. Separate stream arrays alone cannot detect the
warning-above-table regression. Also check color/no-color equivalence, narrow
wrapping, complete setup commands, JSON purity, and unchanged exit behavior.

Use real CLI functions with fixture-backed services for local styling previews;
label their data as illustrative. Do not invoke host installation or checks merely
to inspect formatting. Installed OpenClaw scenarios remain CI-owned unless the
operator explicitly authorizes their execution.
