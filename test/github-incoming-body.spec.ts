import assert from 'node:assert/strict';

import incomingBody from '../channels/github/presentation/incoming-body.ts';

const marker = `<!-- agent-system-github-publication:manual-response:${'a'.repeat(32)} -->`;
describe('channels/github/presentation/incoming-body', () => {
  it('should remove repeated recognized comments without changing surrounding markdown', () => {
    const prose = '@someone [link](https://example.com)\r\n> quoted\r\n';
    assert.equal(incomingBody(`${marker}${prose}${marker}${marker}`), prose);
    for (const intent of [
      'assignment-response',
      'github-reply',
      'initial-acknowledgment',
      'status-update',
      'pull-request-handoff',
    ]) {
      assert.equal(incomingBody(marker.replace('manual-response', intent)), '');
    }
  });
  it('should preserve literal code examples and remove only metadata outside them', () => {
    for (const literal of [
      `\`${marker}\``,
      `\`\`\`html\n${marker}\n\`\`\``,
      `~~~html\n${marker}\n~~~`,
      `> \`\`\`html\n> ${marker}\n> \`\`\``,
      `    ${marker}`,
    ]) {
      assert.equal(incomingBody(`${literal}\n\n${marker}`), `${literal}\n\n`);
    }
  });
  it('should leave marker-free content and unrecognized html untouched', () => {
    for (const body of [
      'plain **markdown**',
      '<!-- unrelated -->',
      marker.replace('manual-response', 'unknown-intent'),
      marker.replace('a'.repeat(32), 'invalid'),
      `<!-- outer ${marker} -->`,
      `\\${marker}`,
      '&lt;!-- agent-system-github-publication:manual-response:example --&gt;',
    ]) {
      assert.equal(incomingBody(body), body);
    }
  });
});
