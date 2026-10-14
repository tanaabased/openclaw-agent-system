import assert from 'node:assert/strict';

import workflowInstructions from '../channels/github/conversation/presentation/workflow-instructions.ts';
import feedbackResponse from '../channels/github/conversation/presentation/feedback-response.ts';

const selection = {
  defaultSkill: false,
  skill: { name: 'piroplugin:piro-feedback-reply', path: '/skills/latin reply/SKILL.md' },
};
describe('channels/github/conversation/presentation/workflow-instructions', () => {
  it('should hide defaults but show linked custom skills and file guidance', () => {
    assert.equal(
      workflowInstructions('Assessment', { ...selection, defaultSkill: true }),
      undefined,
    );
    const card = workflowInstructions(
      'Feedback reply',
      {
        ...selection,
        guidance: {
          source: 'file',
          path: '/workspace/.agent-system/reply #1.md',
          content: 'private',
        },
      },
      '/workspace',
    )!;
    assert.ok(card.includes('[piroplugin:piro-feedback-reply](</skills/latin%20reply/SKILL.md>)'));
    assert.ok(
      card.includes('[.agent-system/reply #1.md](</workspace/.agent-system/reply%20%231.md>)'),
    );
    assert.ok(!card.includes('private'));
    assert.ok(card.split('\n').every((line) => line.startsWith('>')));
  });
  it('should show inline guidance without revealing the default skill or interpreting markdown', () => {
    const card = workflowInstructions('Implementation', {
      ...selection,
      defaultSkill: true,
      guidance: { source: 'inline', content: '```\r\n> keep **literal**\r\n  spacing' },
    })!;
    assert.ok(!card.includes(selection.skill.name));
    assert.ok(card.includes('> ````text\n> ```\n> > keep **literal**\n>   spacing\n> ````'));
  });
  it('should place reply instructions after the public reply and its outcome', () => {
    const output = feedbackResponse({
      privateText: 'Private English answer.',
      publicText: 'Ita.',
      selection,
      publication: { url: 'https://github.com/owner/repo/issues/1#issuecomment-2' },
    });
    assert.ok(output.indexOf('Feedback reply instructions') > output.indexOf('Published reply'));
    assert.ok(output.includes('Private English answer.'));
    const withheld = feedbackResponse({
      privateText: 'Private.',
      selection,
      publication: { withheld: 'blocked' },
    });
    assert.ok(
      withheld.indexOf('Feedback reply instructions') > withheld.indexOf('Public reply withheld'),
    );
  });
});
