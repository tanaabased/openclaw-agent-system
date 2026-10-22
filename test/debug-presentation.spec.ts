import assert from 'node:assert/strict';
import debugCard from '../channels/github/presentation/debug.ts';
import workflowInstructions from '../channels/github/presentation/workflow-instructions.ts';

describe('channels/github/presentation/debug', () => {
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
      assert.ok(card.includes('[chosen](</skill/SKILL.md>)'));
      assert.ok(card.includes('[Inline guidance](</workspace/agent.yaml>)'));
      assert.ok(card.includes('>   **literal**\n> > quoted'));
      assert.ok(card.split('\n').every((line) => line.startsWith('>')));
      assert.doesNotMatch(card, /> > ##|🧩/);
    }
  });
});
