import assert from 'node:assert/strict';

import {
  GitHubAssignmentAcknowledgmentError,
  githubAssignmentAcknowledgment,
  githubAssignmentAcknowledgmentComment,
  githubAssignmentAcknowledgmentMarker,
} from '../channels/github/utils/acknowledgment.ts';

describe('channels/github/utils/acknowledgment', () => {
  it('should accept one short personality-bearing plain-text response', () => {
    assert.equal(
      githubAssignmentAcknowledgment([{ text: "Absolutely — I've got this one." }]),
      "Absolutely — I've got this one.",
    );
  });

  it('should reject unsafe or structurally ambiguous responses', () => {
    const rejected = [
      [],
      [{ text: 'On it.' }, { text: 'I have this.' }],
      [{ mediaUrl: 'file:///tmp/result.txt', text: 'On it.' }],
      [{ text: 'I am on it. I will report back.' }],
      [{ text: 'On it — see https://example.test.' }],
      [{ text: 'On it @pirog.' }],
      [{ text: 'Using GH_TOKEN=secret for this.' }],
      [{ text: 'Working from /Users/agent/private.' }],
      [{ text: 'github_pat_abcdefghijklmnopqrstuvwxyz123456' }],
    ];

    for (const payloads of rejected) {
      assert.throws(
        () => githubAssignmentAcknowledgment(payloads),
        GitHubAssignmentAcknowledgmentError,
      );
    }
  });

  it('should render a deterministic opaque marker without exposing the event id', () => {
    const marker = githubAssignmentAcknowledgmentMarker('EV_assignment-private');

    assert.match(marker, /^<!-- agent-system-github-assignment-ack:[a-f0-9]{32} -->$/u);
    assert.doesNotMatch(marker, /assignment-private/u);
    assert.equal(githubAssignmentAcknowledgmentComment('On it.', marker), `On it.\n\n${marker}`);
  });
});
