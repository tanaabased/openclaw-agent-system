import assert from 'node:assert/strict';

import { githubNotificationItemMatchesSelector } from '../channels/github/provider/work-item.ts';

describe('channels/github/provider/work-item', () => {
  it('should match an exact notification selector with a case-insensitive repository', () => {
    const selector = {
      itemType: 'issue' as const,
      number: 42,
      repository: 'Tanaabased/OpenClaw-Agent-System',
    };

    assert.equal(
      githubNotificationItemMatchesSelector(
        { itemType: 'issue', number: 42 },
        'tanaabased/openclaw-agent-system',
        selector,
      ),
      true,
    );
    assert.equal(
      githubNotificationItemMatchesSelector(
        { itemType: 'pull-request', number: 42 },
        'tanaabased/openclaw-agent-system',
        selector,
      ),
      false,
    );
    assert.equal(
      githubNotificationItemMatchesSelector(
        { itemType: 'issue', number: 41 },
        'tanaabased/openclaw-agent-system',
        selector,
      ),
      false,
    );
    assert.equal(
      githubNotificationItemMatchesSelector(
        { itemType: 'issue', number: 42 },
        'tanaabased/other',
        selector,
      ),
      false,
    );
  });
});
