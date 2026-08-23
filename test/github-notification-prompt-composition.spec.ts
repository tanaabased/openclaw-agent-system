import assert from 'node:assert/strict';

import composeGitHubNotificationPrompt from '../channels/github/conversation/prompts/compose.ts';

describe('channels/github/conversation/prompts/compose', () => {
  it('should label each trusted prompt contribution', () => {
    assert.equal(
      composeGitHubNotificationPrompt({
        eventInstructions: 'event guidance',
        lifecycleInstructions: 'lifecycle guidance',
        modeInstructions: 'mode guidance',
        modeLifecycleInstructions: 'lifecycle-mode guidance',
        responseInstructions: '## Response format\n\nresponse guidance',
      }),
      [
        '## Lifecycle',
        'lifecycle guidance',
        '## Lifecycle mode',
        'lifecycle-mode guidance',
        '## Mode',
        'mode guidance',
        '## Event',
        'event guidance',
        '## Response format',
        'response guidance',
      ].join('\n\n'),
    );
  });
});
