import assert from 'node:assert/strict';

import workflowInstructions from '../channels/github/conversation/presentation/workflow-instructions.ts';
import feedbackResponse from '../channels/github/conversation/presentation/feedback-response.ts';

const selection = {
  defaultSkill: false,
  skill: { name: 'piroplugin:piro-feedback-reply', path: '/skills/latin reply/SKILL.md' },
};
describe('channels/github/conversation/presentation/workflow-instructions', () => {
  it('should hide instructions unless debug is enabled and link retained sources', () => {
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
      { debug: true },
    )!;
    assert.ok(card.includes('[piroplugin:piro-feedback-reply](</skills/latin%20reply/SKILL.md>)'));
    assert.ok(
      card.includes('[.agent-system/reply #1.md](</workspace/.agent-system/reply%20%231.md>)'),
    );
    assert.ok(!card.includes('private'));
    assert.ok(card.split('\n').every((line) => line.startsWith('>')));
  });
  it('should show default skills and literal inline guidance with its manifest link in debug mode', () => {
    const card = workflowInstructions(
      'Implementation',
      {
        ...selection,
        defaultSkill: true,
        guidance: { source: 'inline', content: '```\r\n> keep **literal**\r\n  spacing' },
      },
      '/workspace',
      { debug: true, manifestPath: '/workspace/agent.yaml' },
    )!;
    assert.ok(card.includes(selection.skill.name));
    assert.ok(card.includes('(default)'));
    assert.ok(card.includes('[Inline guidance](</workspace/agent.yaml>)'));
    assert.ok(card.includes('> ````text\n> ```\n> > keep **literal**\n>   spacing\n> ````'));
  });
  it('should preserve replies and blockers while hiding all instructions by default', () => {
    for (const debug of [undefined, false]) {
      const output = feedbackResponse({
        privateText: 'Private answer.',
        publicText: 'Public answer.',
        debug,
        selection: { ...selection, guidance: { source: 'inline', content: 'Hidden guidance.' } },
        publication: { withheld: 'approval-denied' },
      });
      assert.ok(!output.includes('Feedback reply instructions'));
      assert.ok(!output.includes('Hidden guidance.'));
      assert.ok(output.includes('Private answer.') && output.includes('Public answer.'));
      assert.ok(output.includes('approval-denied'));
    }
    assert.ok(
      workflowInstructions('Assessment', { ...selection, defaultSkill: true }, undefined, {
        debug: true,
      })?.includes('(default)'),
    );
  });
  it('should place reply instructions after the public reply and its outcome', () => {
    const output = feedbackResponse({
      privateText: 'Private English answer.',
      publicText: 'Ita.',
      selection,
      debug: true,
      publication: { url: 'https://github.com/owner/repo/issues/1#issuecomment-2' },
    });
    assert.ok(output.indexOf('Feedback reply instructions') > output.indexOf('Published reply'));
    assert.ok(output.includes('Private English answer.'));
    assert.ok(output.includes('> ## 📤 To GitHub\n>\n> Ita.'));
    const withheld = feedbackResponse({
      privateText: 'Private.',
      selection,
      debug: true,
      publication: { withheld: 'blocked' },
    });
    assert.ok(
      withheld.indexOf('Feedback reply instructions') > withheld.indexOf('Public reply withheld'),
    );
  });
});
