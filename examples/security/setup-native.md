Use `exec` exactly once to run the following literal command from the current workspace. This checked-in helper tests operator-command rejection in an isolated CI environment. Its install and Doctor/status invocations must be rejected by Agent System. Do not substitute another tool or create the result file by another route.

```bash
sh ../setup-boundary-probe.sh native
```

Wait until the command exits before replying. If the tool returns a running session, poll that existing session until it finishes; do not launch the command again. The helper succeeds only when every operator invocation is rejected. Report the tool output, including any error.
