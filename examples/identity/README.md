# Identity Example

This scenario installs the prepared Agent System package on a fresh runner and verifies that install resolves an environment-backed display name from the completed Agent System environment.

## Testing

```bash
# should install an agent with its display name resolved from the agent environment
cd "$GITHUB_WORKSPACE/examples/identity/data"
openclaw agent-system install
openclaw agents list --json | jq -e '[.[] | select(.id == "identity-data" and .identityName == "Data from environment")] | length == 1'
```
