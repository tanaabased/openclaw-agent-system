import assert from 'node:assert/strict';
import debugCard from '../channels/github/presentation/debug.ts';
import workflowInstructions from '../channels/github/presentation/workflow-instructions.ts';

describe('channels/github/presentation/debug', () => {
  it('should code technical link labels while preserving targets and ordinary guidance labels', () => {
    const card = workflowInstructions(
      'Assessment',
      {
        defaultSkill: false,
        skill: { name: 'cats:`assess`', path: '/skills/assess/SKILL.md' },
        guidance: { source: 'file', path: '/workspace/a[b]`c`.md', content: 'not displayed' },
      },
      '/workspace',
      { debug: true },
    )!;
    assert.ok(card.includes('[`` cats:`assess` ``](</skills/assess/SKILL.md>)'));
    assert.ok(card.includes('[``a[b]`c`.md``](</workspace/a%5Bb%5D%60c%60.md>)'));
    assert.ok(!card.includes('not displayed'));
  });

  it('should omit disabled and empty diagnostics and quote literal content once', () => {
    for (const debug of [undefined, false, true]) {
      assert.equal(debugCard({ debug, context: 'Assessment', detail: '  ' }), undefined);
      if (!debug)
        assert.equal(
          debugCard({ debug, context: 'Assessment', facts: [{ label: 'Skill', value: 'chosen' }] }),
          undefined,
        );
    }
    for (const stage of ['Assessment', 'Implementation', 'Feedback reply', 'Review'] as const) {
      const card = workflowInstructions(
        stage,
        {
          defaultSkill: true,
          skill: { name: 'chosen', path: '/skill/SKILL.md' },
          guidance: { source: 'inline', content: '  **literal**\n> quoted' },
        },
        '/workspace',
        { debug: true, manifestPath: '/workspace/agent.yaml' },
      )!;
      assert.match(card, /^> ## 🔬 Debug/);
      assert.ok(card.includes(stage + ' instructions'));
      assert.ok(card.includes('[`chosen`](</skill/SKILL.md>)'));
      assert.ok(card.includes('[Inline guidance](</workspace/agent.yaml>)'));
      assert.ok(card.includes('>   **literal**\n> > quoted'));
      assert.ok(card.split('\n').every((line) => line.startsWith('>')));
      assert.doesNotMatch(card, /> > ##|🧩/);
    }
  });
});
