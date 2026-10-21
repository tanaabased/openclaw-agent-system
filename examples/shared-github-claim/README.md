# GitHub Claim Trial

Race two persisted instances against one disposable issue in `tanaabased/big-test-bucket` using the prepared package. Verify two-pass selection, lost-response recovery, loser cleanup, customizable names and explicit identity rotation. Only Tanaabot receives the assignment; EMORI creates and closes the fixture.

Successful runs retain the winning comment on the closed issue for inspection. Failed runs remove their claim comments.

Native preparation is a counted callback. This scenario exercises the claim protocol directly against GitHub; it starts no native chat or Gateway. The dependent OpenClaw claim scenario verifies native dispatch.

## Testing

```bash
# should select one two-pass claimant using the prepared package and disposable github state
node --import tsx "$GITHUB_WORKSPACE/scripts/github-claim-trial-task.ts"
```
