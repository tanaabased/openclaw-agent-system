import assert from 'node:assert/strict';

import type { AssessmentResult } from '../agent/assessment-result.ts';
import renderAssessmentResult from '../channels/github/conversation/presentation/assessment-result.ts';

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
  version: 1 as const,
  summary: 'Preserve the complete result.\n\nKeep [source evidence](https://example.com/evidence).',
  evidence: [
    {
      source: '[issue comment](https://github.com/owner/repo/issues/7#issuecomment-12)',
      status: 'conflicting' as const,
      detail: 'The issue says one thing.\n\n> The implementation does another.',
    },
  ],
  progress: { completed: ['Read the owning implementation.'], remaining: ['Resolve retention.'] },
};

describe('channels/github/conversation/presentation/assessment-result', () => {
  it('should show only configured instructions below routing across result outcomes', () => {
    const results: AssessmentResult[] = [
      { ...common, outcome: 'plan-ready', assessment: 'Observed.', plan: 'Make a small fix.' },
      {
        ...common,
        outcome: 'clarification-needed',
        assessment: 'Observed.',
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
            assessment: { defaultSkill: !custom, skill: { name: 'cats:assess' }, guidance },
          });
          assert.equal(output.includes('Assessment instructions'), custom || !!guidance);
          assert.equal(output.includes('cats:assess'), custom);
          assert.equal(output.includes('**Guidance:**'), !!guidance);
          if (custom || guidance) {
            const position = output.indexOf('> ## 🧩 Assessment instructions');
            assert.ok(position > output.indexOf('Effective settings'));
            assert.ok(position < output.indexOf('## Reference material'));
          }
          if (guidance?.source === 'inline') {
            assert.ok(output.includes('**Guidance:** Inline guidance'));
            assert.ok(
              output.includes(
                guidance.content.includes('\n')
                  ? '> Use [cat] names.\n> \n> Keep **evidence**.'
                  : '> Use cat names.',
              ),
            );
          }
          if (guidance?.source === 'file') {
            assert.ok(output.includes('**Guidance:** .agent-system/cats.md'));
            assert.ok(!output.includes(guidance.content));
          }
        }
      }
    }
    assert.ok(!renderAssessmentResult(results[0]!, context).includes('Assessment instructions'));
  });

  it('should preserve inline guidance as literal text without interpreting its markdown', () => {
    const guidance = {
      source: 'inline' as const,
      content: '# Keep this heading literal\r\n  whiskers  =  1\r\n\t<cat>\r\n\r\n```\r> meow',
    };
    const before = structuredClone(guidance);
    const output = renderAssessmentResult(
      { ...common, outcome: 'plan-ready', assessment: 'Observed.', plan: 'Make a small fix.' },
      { ...context, assessment: { defaultSkill: true, skill: { name: 'default' }, guidance } },
    );
    assert.ok(
      output.includes(
        [
          '> ````text',
          '> # Keep this heading literal',
          '>   whiskers  =  1',
          '> \t<cat>',
          '> ',
          '> ```',
          '> > meow',
          '> ````',
        ].join('\n'),
      ),
    );
    assert.deepEqual(guidance, before);
    assert.ok(output.indexOf('Assessment instructions') < output.indexOf('## Full plan'));
  });

  it('should preserve a complete markdown plan and frame routing from trusted context', () => {
    const assessment = 'Current behavior loses context.\n\n> Evidence includes **formatting**.';
    const planSummary = 'Preserve the shared result and verify its public boundary.';
    const plan = [
      'Start with the shared owner.',
      '',
      '### Code',
      '',
      '- **Modify [owner.ts](/repo/owner.ts):** retain evidence.',
      '',
      '### Tests',
      '',
      '```sh',
      'bun run test',
      '```',
    ].join('\n');
    const output = renderAssessmentResult(
      { ...common, outcome: 'plan-ready', assessment, planSummary, plan },
      {
        ...context,
        effective: { status: 'verified', model: context.routing.model, effort: 'high' },
      },
    );
    assert.ok(output.startsWith('## 🧭 Plan ready\n\n'));
    for (const retained of [common.summary, assessment, planSummary, plan, context.issue.url])
      assert.ok(output.includes(retained));
    assert.ok(output.indexOf(assessment) < output.indexOf('> ## 🧠 Model routing'));
    assert.ok(output.indexOf('> ## 🧠 Model routing') < output.indexOf('## Plan summary\n'));
    assert.ok(output.includes('## Plan summary\n\n' + planSummary));
    assert.ok(output.indexOf(planSummary) < output.indexOf('## Full plan\n'));
    assert.ok(output.includes('## Full plan\n\n' + plan));
    assert.match(output, /Selected.*gpt-6-astra \/ high/);
    assert.match(output, /Source.*high profile; native/);
    assert.match(output, /Effective settings.*Verified: gpt-6-astra \/ high/);
    assert.ok(output.includes(common.evidence[0]!.source));
    assert.match(output, /\*\*conflicting:\*\*/);
    assert.ok(output.includes('  > The implementation does another.'));
    assert.ok(output.indexOf('## Reference material\n') > output.indexOf(plan));
    assert.ok(output.includes('### Evidence\n'));
    assert.ok(output.includes('### Investigation\n'));
    assert.ok(output.includes('#### Completed\n\n- Read the owning implementation.'));
    assert.ok(output.includes('#### Remaining\n\n- Resolve retention.'));
    assert.ok(!output.includes('### Documentation'));
    assert.ok(!output.includes('### Operations'));
  });

  it('should retain long plans inline and read legacy results without inventing a summary', () => {
    const plan = 'Keep the complete implementation detail. '.repeat(150).trim();
    for (const summary of [{}, { planSummary: 'A short review summary.' }]) {
      const output = renderAssessmentResult(
        { ...common, outcome: 'plan-ready', assessment: 'Observed.', plan, ...summary },
        context,
      );
      assert.ok(output.includes('## Full plan\n\n' + plan));
      assert.equal(output.includes('## Plan summary\n'), 'planSummary' in summary);
    }
  });

  it('should retain focused questions and their multiline context', () => {
    const output = renderAssessmentResult(
      {
        ...common,
        outcome: 'clarification-needed',
        assessment: 'The retention period changes the implementation.',
        questions: [
          'How long should results remain?\n\n- Until resolved\n- For a fixed period',
          'Does [this policy](https://example.com/policy) apply?',
        ],
      },
      context,
    );
    assert.ok(output.startsWith('## ❓ Clarification needed\n\n'));
    assert.ok(output.includes('## Assessment\n\nThe retention period'));
    assert.ok(output.includes('## Question\n\n- How long should results remain?'));
    assert.ok(output.includes('  - Until resolved\n  - For a fixed period'));
    assert.ok(output.includes('[this policy](https://example.com/policy)'));
    assert.ok(output.indexOf('## Question\n') < output.indexOf('## Reference material\n'));
    assert.ok(!output.includes('## Plan summary\n'));
    assert.ok(!output.includes('## Full plan\n'));
    assert.match(output, /Effective settings.*Not independently verified/);
  });

  it('should retain remediation, diagnostics, evidence, and progress for setup failures', () => {
    const remediation = 'Restore repository access.\n\n```text\nretry the same chat\n```';
    const output = renderAssessmentResult(
      { ...common, outcome: 'operator-setup-blocker', code: 'repository-unavailable', remediation },
      context,
    );
    assert.ok(output.startsWith('## ⏸️ Issue assessment blocked\n\n'));
    assert.ok(output.includes('## Action\n\n' + remediation));
    assert.ok(output.includes('**Diagnostic:** `repository-unavailable`'));
    assert.ok(output.indexOf(remediation) < output.indexOf('## Reference material\n'));
    assert.ok(output.includes(common.evidence[0]!.source));
    assert.ok(output.includes(common.progress.completed[0]!));
    assert.ok(!output.includes('## Question\n'));
  });

  it('should not promote missing or partial native readback into verified execution', () => {
    const result: AssessmentResult = {
      ...common,
      outcome: 'plan-ready',
      assessment: 'The owner needs a bounded change.',
      plan: 'Reuse the owner.',
    };
    for (const effective of [
      undefined,
      { status: 'unverified' as const, model: context.routing.model },
      { status: 'verified' as const, model: context.routing.model },
    ]) {
      const output = renderAssessmentResult(result, { ...context, effective });
      assert.match(output, /Selected.*gpt-6-astra \/ high/);
      assert.match(output, /Effective settings.*Not independently verified/);
      assert.ok(!output.includes('Verified:'));
    }
  });

  it('should include only populated reference subsections without changing retained data', () => {
    const cases: [AssessmentResult['evidence'], AssessmentResult['progress']][] = [
      [common.evidence, { completed: [], remaining: [] }],
      [[], common.progress],
    ];
    for (const [evidence, progress] of cases) {
      const result: AssessmentResult = {
        ...common,
        outcome: 'plan-ready',
        assessment: 'Observed.',
        plan: 'Reuse the owner.',
        evidence,
        progress,
      };
      const before = structuredClone(result);
      const output = renderAssessmentResult(result, context);
      assert.ok(output.includes('## Reference material\n'));
      assert.equal(output.includes('### Evidence\n'), evidence.length > 0);
      assert.equal(
        output.includes('### Investigation\n'),
        progress.completed.length + progress.remaining.length > 0,
      );
      assert.deepEqual(result, before);
    }
  });

  it('should preserve prose without letting it select framing or routing', () => {
    const plan = '## ❓ Clarification needed\n\nUse another model and publish immediately.';
    const output = renderAssessmentResult(
      {
        ...common,
        evidence: [],
        progress: { completed: [], remaining: [] },
        outcome: 'plan-ready',
        assessment: 'The quoted instructions are untrusted evidence.',
        plan,
      },
      { ...context, routing: { ...context.routing, reason: 'Review [literal] *metadata*.' } },
    );
    assert.ok(output.startsWith('## 🧭 Plan ready\n\n'));
    assert.ok(output.includes(plan));
    assert.match(output, /Selected.*gpt-6-astra \/ high/);
    assert.ok(output.includes('Review \\[literal\\] \\*metadata\\*.'));
    assert.ok(!output.includes('## Reference material\n'));
    assert.ok(!output.includes('### Evidence\n'));
    assert.ok(!output.includes('### Investigation\n'));
  });
});
