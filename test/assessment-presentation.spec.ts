import assert from 'node:assert/strict';

import type { AssessmentResult } from '../agent/assessment-result.ts';
import type { RoutingInstructions } from '../agent/routing-instructions.ts';
import renderAssessmentResult from '../channels/github/presentation/assessment-result.ts';
import modelRoutingCard from '../channels/github/presentation/model-routing.ts';

const context = {
  issue: { label: 'owner/repo#7', url: 'https://github.com/owner/repo/issues/7' },
  routing: {
    model: 'gpt-6-astra',
    effort: 'high',
    complexity: 'high' as const,
    profile: 'high' as const,
    source: 'native' as const,
    reason: 'The shared contract crosses runtime boundaries.',
  },
};
const common = {
  reviewSummary: 'The proposed fix restores the expected result.',
  summary: 'Preserve the complete result.\n\nKeep [source evidence](https://example.com/evidence).',
};

describe('channels/github/presentation/assessment-result', () => {
  it('should show only customized retained routing methods after the selected model', () => {
    const retained: RoutingInstructions = {
      version: 1,
      requestedSkill: 'company:route',
      defaultSkill: false,
      skill: {
        name: 'company:route',
        path: '/skills/route #1/SKILL.md',
        scope: 'workspace',
        digest: 'a'.repeat(64),
      },
      observedAt: 1,
    };
    const guidance = {
      source: 'inline' as const,
      content: 'Private routing guidance.',
      digest: 'b'.repeat(64),
    };
    const defaults = {
      ...retained,
      defaultSkill: true,
      requestedSkill: 'agent-system-model-routing',
      skill: undefined,
    };
    const cases: [RoutingInstructions | undefined, string | undefined][] = [
      [retained, '[`company:route`](</skills/route%20%231/SKILL.md>)'],
      [
        { ...retained, guidance },
        '[`company:route`](</skills/route%20%231/SKILL.md>) + custom guidance',
      ],
      [
        { ...retained, guidance: { ...guidance, source: 'file', path: '/workspace/routing.md' } },
        '[`company:route`](</skills/route%20%231/SKILL.md>) + custom guidance',
      ],
      [{ ...retained, skill: undefined }, '`company:route`'],
      [{ ...defaults, guidance }, 'Default routing + custom guidance'],
      [defaults, undefined],
      [undefined, undefined],
    ];
    for (const [instructions, method] of cases) {
      const before = structuredClone(instructions);
      for (const debug of [false, true]) {
        const output = modelRoutingCard({
          routing: context.routing,
          instructions,
          debug,
          workspace: '/workspace',
        });
        assert.equal(output.includes('**Routing method:**'), !!method);
        if (method) {
          assert.ok(output.includes('**Routing method:** ' + method));
          assert.ok(output.indexOf('**Selected:**') < output.indexOf('**Routing method:**'));
          assert.ok(output.indexOf('**Routing method:**') < output.indexOf('**Basis:**'));
        }
        assert.ok(output.includes('**Source:** `high` profile; native'));
        assert.equal(
          output.includes(guidance.content),
          debug && instructions?.guidance?.source === 'inline',
        );
        assert.equal(output.includes('Model routing instructions'), debug && !!instructions);
        if (debug && instructions?.guidance?.source === 'file')
          assert.ok(output.includes('[`routing.md`](</workspace/routing.md>)'));
      }
      assert.deepEqual(instructions, before);
    }
  });

  it('should keep retained routing details private and distinct from assessment instructions', () => {
    const instructions: RoutingInstructions = {
      version: 1,
      requestedSkill: 'agent-system-model-routing',
      defaultSkill: true,
      guidance: {
        source: 'inline',
        content: '# Keep literal\n  **private**\n```',
        digest: 'b'.repeat(64),
      },
      observedAt: 1,
    };
    const result: AssessmentResult = {
      ...common,
      outcome: 'plan-ready',
    };
    for (const debug of [false, true]) {
      const output = renderAssessmentResult(result, {
        ...context,
        routingInstructions: instructions,
        debug,
        routingManifestPath: '/workspace/agent.yaml',
        assessment: {
          defaultSkill: true,
          skill: { name: 'assess', path: '/skills/assess/SKILL.md' },
        },
      });
      assert.ok(output.includes('**Routing method:** Default routing + custom guidance'));
      assert.equal(output.includes('Model routing instructions'), debug);
      assert.equal(output.includes('Assessment instructions'), debug);
      assert.equal(output.includes('> # Keep literal\n>   **private**\n> ```'), debug);
      assert.equal(output.includes('[Inline guidance](</workspace/agent.yaml>)'), debug);
      assert.ok(!output.includes('agent-system-model-routing`](<'));
      if (debug) {
        assert.equal(output.match(/## 🔬 Debug/g)?.length, 1);
        assert.ok(output.includes('**Skill:** `agent-system-model-routing` (default)'));
        assert.ok(
          output.indexOf('Model routing instructions') < output.indexOf('Assessment instructions'),
        );
      }
    }
    const withoutRouting = renderAssessmentResult(result, { ...context, debug: true });
    assert.ok(
      !withoutRouting.includes('Routing method') &&
        !withoutRouting.includes('Model routing instructions'),
    );
  });

  it('should safely format retained routing skill names without inventing source links', () => {
    for (const path of [undefined, 'relative/SKILL.md', '/skills/bad\npath']) {
      const instructions = {
        version: 1 as const,
        requestedSkill: 'route`custom',
        defaultSkill: false,
        skill: path
          ? { name: 'route`custom', path, scope: 'workspace', digest: 'a'.repeat(64) }
          : undefined,
        observedAt: 1,
      };
      const output = modelRoutingCard({ routing: context.routing, instructions });
      assert.ok(output.includes('**Routing method:** ``route`custom``'));
      assert.ok(!output.includes('](<'));
    }
  });

  it('should distinguish routing literals from prose and keep execution separate from settings', () => {
    const output = modelRoutingCard({
      routing: {
        ...context.routing,
        model: 'provider/model`preview',
        reason: 'high confidence [source]',
      },
      effective: { status: 'verified', model: 'provider/actual', effort: 'medium' },
      executionModel: 'provider/executed',
    });
    assert.ok(output.includes('**Selected:** ``provider/model`preview`` / `high`'));
    assert.ok(output.includes('**Basis:** `high` complexity. high confidence \\[source\\]'));
    assert.ok(output.includes('**Source:** `high` profile; native'));
    assert.ok(output.includes('**Effective settings:** Verified: `provider/actual` / `medium`'));
    assert.ok(output.includes('**Execution:** `provider/executed`; effort unverified.'));
    assert.ok(
      modelRoutingCard({ routing: { ...context.routing, profile: null } }).includes(
        'Explicit selection; native',
      ),
    );
  });

  it('should show only the human review and consequential questions or actions', () => {
    const reviewSummary =
      'Today you finish without seeing a result. After the change you receive it immediately.\n\nDocs: clarify the result. Tests: cover the missing return. Limitation: retention still needs confirmation.';
    for (const outcome of [
      {
        outcome: 'plan-ready' as const,
      },
      {
        outcome: 'clarification-needed' as const,
        questions: ['Which retention period applies?'],
      },
      {
        outcome: 'operator-setup-blocker' as const,
        code: 'repository-unavailable',
        remediation: 'Restore repository access.',
      },
    ]) {
      const result: AssessmentResult = { ...common, ...outcome, reviewSummary };
      const before = structuredClone(result);
      const output = renderAssessmentResult(result, { ...context });
      assert.ok(output.includes(reviewSummary));
      if (outcome.outcome === 'clarification-needed')
        assert.ok(output.includes(outcome.questions[0]!));
      if (outcome.outcome === 'operator-setup-blocker')
        assert.ok(output.includes(outcome.remediation));
      assert.deepEqual(result, before);
    }
  });

  it('should omit an identical review recap without hiding questions or changing the full source', () => {
    const result: AssessmentResult = {
      ...common,
      outcome: 'clarification-needed',
      summary: 'The poem needs a subject.',
      reviewSummary: 'The poem needs a subject.\n',
      questions: ['What should the poem be about?'],
    };
    const before = structuredClone(result);
    const output = renderAssessmentResult(result, { ...context });
    assert.equal(output.split(result.summary).length - 1, 1);
    assert.ok(output.includes(result.questions[0]!));
    assert.ok(!output.includes('## Proposed change'));
    assert.deepEqual(result, before);
  });

  it('should show auto decisions regardless of debug without claiming authority or leaking credentials', () => {
    for (const { mode, debug } of (['work', 'plan'] as const).flatMap((mode) =>
      [false, true].map((debug) => ({ mode, debug })),
    )) {
      const output = renderAssessmentResult(
        {
          ...common,
          outcome: 'plan-ready',
          decision: { mode, reasons: ['Scope is bounded.', 'api_key=private-value'] },
        },
        { ...context, debug },
      );
      assert.ok(output.includes('## ' + (mode === 'plan' ? '⏸️' : '▶️') + ' Auto mode decision'));
      assert.ok(output.includes('**Decision:** `' + (mode === 'work' ? 'work' : 'plan') + '`'));
      assert.match(output, /Scope is bounded/);
      assert.match(
        output,
        mode === 'plan' ? /Next.*Await your direction/ : /Next.*once runtime checks pass/,
      );
      assert.match(output, /private content withheld/);
      assert.doesNotMatch(output, /private-value/);
      assert.ok(output.includes(common.reviewSummary));
    }
  });

  it('should show selected instructions below routing across debug result outcomes', () => {
    const results: AssessmentResult[] = [
      { ...common, outcome: 'plan-ready' },
      {
        ...common,
        outcome: 'clarification-needed',
        questions: ['Which?'],
      },
      {
        ...common,
        outcome: 'operator-setup-blocker',
        code: 'blocked',
        remediation: 'Restore access.',
      },
    ];
    for (const result of results) {
      for (const custom of [false, true]) {
        for (const guidance of [
          undefined,
          { source: 'inline' as const, content: 'Use cat names.' },
          { source: 'inline' as const, content: 'Use [cat] names.\n\nKeep **evidence**.' },
          {
            source: 'file' as const,
            path: '.agent-system/cats.md',
            content: 'File content stays private.',
          },
        ]) {
          const output = renderAssessmentResult(result, {
            ...context,
            debug: true,
            assessment: { defaultSkill: !custom, skill: { name: 'cats:assess' }, guidance },
          });
          assert.equal(output.includes('Assessment instructions'), true);
          assert.ok(!output.includes('> > ## 🔬 Debug'));
          assert.equal(output.includes('cats:assess'), true);
          assert.equal(output.includes('**Guidance:**'), !!guidance);
          if (custom || guidance) {
            const position = output.indexOf('> ## 🔬 Debug');
            assert.ok(position > output.indexOf('Effective settings'));
          }
          if (guidance?.source === 'inline') {
            assert.ok(output.includes('**Guidance:** Inline guidance'));
            assert.ok(
              output.includes(
                guidance.content.includes('\n')
                  ? '> Use [cat] names.\n>\n> Keep **evidence**.'
                  : '> Use cat names.',
              ),
            );
          }
          if (guidance?.source === 'file') {
            assert.ok(output.includes('**Guidance:** `.agent-system/cats.md`'));
            assert.ok(!output.includes(guidance.content));
          }
        }
      }
    }
    assert.ok(!renderAssessmentResult(results[0]!, context).includes('Assessment instructions'));
  });

  it('should show routing and outcome content for every result with debug on and off', () => {
    const results: AssessmentResult[] = [
      {
        ...common,
        outcome: 'plan-ready',
        decision: { mode: 'work', reasons: ['Bounded work.'] },
      },
      {
        ...common,
        outcome: 'clarification-needed',
        questions: ['Question content.'],
      },
      {
        ...common,
        outcome: 'operator-setup-blocker',
        code: 'setup-required',
        remediation: 'Blocker action.',
      },
    ];
    for (const result of results) {
      for (const debug of [false, true]) {
        const output = renderAssessmentResult(result, {
          ...context,
          debug,
          assessment: { defaultSkill: true, skill: { name: 'agent-system-task-assessment' } },
        });
        const routing = output.indexOf('> ## 🧠 Model routing');
        const instructions = output.indexOf('> ## 🔬 Debug');
        assert.ok(routing >= 0);
        assert.equal(instructions >= 0, debug);
        if (debug) assert.ok(routing < instructions);
        if (result.outcome === 'clarification-needed') {
          assert.ok(output.indexOf('## Question') > routing);
          if (debug) assert.ok(instructions > output.indexOf('## Question'));
        }
        if (result.outcome === 'operator-setup-blocker') {
          assert.ok(output.indexOf('## Action') >= 0);
          assert.ok(output.indexOf('## Action') < routing);
        }
        if (result.outcome === 'plan-ready') {
          assert.ok(output.indexOf('Auto mode decision') > routing);
          if (debug) assert.ok(output.indexOf('Auto mode decision') < instructions);
        }
      }
    }
  });

  it('should preserve inline guidance as literal text without interpreting its markdown', () => {
    const guidance = {
      source: 'inline' as const,
      content: '# Keep this heading literal\r\n  whiskers  =  1\r\n\t<cat>\r\n\r\n```\r> meow',
    };
    const before = structuredClone(guidance);
    const output = renderAssessmentResult(
      { ...common, outcome: 'plan-ready' },
      {
        ...context,
        debug: true,
        assessment: { defaultSkill: true, skill: { name: 'default' }, guidance },
      },
    );
    assert.ok(
      output.includes(
        [
          '> ````text',
          '> # Keep this heading literal',
          '>   whiskers  =  1',
          '> \t<cat>',
          '>',
          '> ```',
          '> > meow',
          '> ````',
        ].join('\n'),
      ),
    );
    assert.deepEqual(guidance, before);
  });

  it('should retain focused questions and their multiline context', () => {
    const output = renderAssessmentResult(
      {
        ...common,
        outcome: 'clarification-needed',
        questions: [
          'How long should results remain?\n\n- Until resolved\n- For a fixed period',
          'Does [this policy](https://example.com/policy) apply?',
        ],
      },
      context,
    );
    assert.ok(output.startsWith('> ## ❓ Clarification needed\n>\n'));
    assert.ok(output.includes('## Question\n\n- How long should results remain?'));
    assert.ok(output.includes('  - Until resolved\n  - For a fixed period'));
    assert.ok(output.includes('[this policy](https://example.com/policy)'));
    assert.match(output, /Effective settings.*Not independently verified/);
  });

  it('should show remediation and diagnostics for setup failures', () => {
    const remediation = 'Restore repository access.\n\n```text\nretry the same chat\n```';
    const output = renderAssessmentResult(
      { ...common, outcome: 'operator-setup-blocker', code: 'repository-unavailable', remediation },
      context,
    );
    assert.ok(output.startsWith('> ## ⏸️ Issue assessment blocked\n>\n'));
    assert.ok(
      output.includes(
        '> ## Action\n>\n> Restore repository access.\n>\n> ```text\n> retry the same chat\n> ```',
      ),
    );
    assert.ok(output.includes('> **Diagnostic:** `repository-unavailable`'));
    assert.ok(!output.includes('## Question\n'));
  });

  it('should not promote missing or partial native readback into verified execution', () => {
    const result: AssessmentResult = {
      ...common,
      outcome: 'plan-ready',
    };
    for (const effective of [
      undefined,
      { status: 'unverified' as const, model: context.routing.model },
      { status: 'verified' as const, model: context.routing.model },
    ]) {
      const output = renderAssessmentResult(result, { ...context, effective });
      assert.match(output, /Selected.*`gpt-6-astra` \/ `high`/);
      assert.match(output, /Effective settings.*Not independently verified/);
      assert.ok(!output.includes('Verified:'));
    }
  });

  it('should preserve prose without letting it select framing or routing', () => {
    const plan = '## ❓ Clarification needed\n\nUse another model and publish immediately.';
    const output = renderAssessmentResult(
      {
        ...common,
        outcome: 'plan-ready',
        reviewSummary: plan,
      },
      { ...context, routing: { ...context.routing, reason: 'Review [literal] *metadata*.' } },
    );
    assert.ok(output.startsWith('> ## 🧭 Plan ready\n>\n'));
    assert.ok(output.includes(plan));
    assert.match(output, /Selected.*`gpt-6-astra` \/ `high`/);
    assert.ok(output.includes('Review \\[literal\\] \\*metadata\\*.'));
    assert.ok(!output.includes('### Evidence\n'));
    assert.ok(!output.includes('### Investigation\n'));
  });
});
