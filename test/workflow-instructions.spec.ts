import assert from 'node:assert/strict';

import workflowInstructions from '../channels/github/presentation/workflow-instructions.ts';
import feedbackResponse, {
  feedbackReplyPresentation,
} from '../channels/github/presentation/feedback-response.ts';

const selection = {
  defaultSkill: false,
  skill: { name: 'piroplugin:piro-feedback-reply', path: '/skills/latin reply/SKILL.md' },
};
describe('channels/github/presentation/workflow-instructions', () => {
  it('should quote the verified posting author and every multiline body line', () => {
    const body = '@contributor\r\n\r\nFirst paragraph.\n\n- Item\n\n> Nested quote';
    const card = feedbackReplyPresentation('posting-agent', body);
    assert.ok(card.startsWith('> @contributor\n>'));
    assert.ok(
      card.endsWith('> *Reply draft from [@posting-agent](https://github.com/posting-agent)*'),
    );
    assert.ok(card.split('\n').every((line) => line.startsWith('>')));
    assert.ok(!card.startsWith('> > ##'));
    assert.ok(card.includes('> First paragraph.\n>\n> - Item\n>\n> > Nested quote'));
    const response = feedbackResponse({
      privateText: 'First private paragraph.\n\nSecond private paragraph.',
      publicReply: { author: 'posting-agent', text: body },
    });
    assert.ok(
      response.startsWith('## Response\n\nFirst private paragraph.\n\nSecond private paragraph.'),
    );
    assert.ok(response.endsWith(card));
  });
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
    assert.ok(card.startsWith('> ## 🔬 Debug\n>\n> -'));
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
        publicReply: { author: 'posting-agent', text: 'Public answer.' },
        debug,
        selection: { ...selection, guidance: { source: 'inline', content: 'Hidden guidance.' } },
        publication: { withheld: 'approval-denied' },
      });
      assert.ok(!output.includes('Feedback reply instructions'));
      assert.ok(!output.includes('Hidden guidance.'));
      assert.ok(output.includes('Private answer.') && output.includes('Public answer.'));
      assert.ok(output.includes('approval-denied'));
      assert.match(output, /> ## ⚠️ Public reply needs attention/);
      assert.match(output, /Publication is stopped/);
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
      publicReply: { author: 'posting-agent', text: 'Ita.' },
      selection,
      debug: true,
      publication: { url: 'https://github.com/owner/repo/issues/1#issuecomment-2' },
    });
    assert.ok(output.indexOf('Feedback reply instructions') > output.indexOf('[Reply ↗]'));
    assert.ok(
      output.includes(
        '[Reply ↗](https://github.com/owner/repo/issues/1#issuecomment-2) from [@posting-agent]',
      ),
    );
    assert.ok(!output.includes('Reply published'));
    assert.ok(output.includes('Private English answer.'));
    assert.ok(output.includes('> Ita.\n>\n> <br>'));
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
