import { nativeAssessmentInstructions } from '../agent/assessment-instructions.ts';
import { assessmentResultContextSchema } from '../agent/assessment-result.ts';

export default function assessmentContextFixture(runtime: 'openclaw' | 'codex' = 'openclaw') {
  return {
    status: 'verified',
    runtime,
    entry: 'managed',
    id: 'a'.repeat(64),
    currentTurnId: `${'a'.repeat(64)}:assessment`,
    mode: 'work',
    recording: 'native-context',
    project: {
      path: '/home/runner/work/project/examples/picker/.agent-system/worktrees/github-project/issue-123',
    },
    routing: {
      complexity: 'low',
      reason: 'A bounded cleanup clarification.',
      selection: { model: 'openai/gpt-5.4-nano', effort: 'medium' },
    },
    effective: { status: 'verified', model: 'openai/gpt-5.4-nano', effort: 'medium' },
    evidence: {
      source: 'https://github.com/tanaabased/big-test-bucket/issues/123',
      title: 'Clarify cleanup',
      body: 'Clarify when disposable issues close after evidence capture.',
      comments: [],
    },
    assessment: {
      skill: {
        name: 'agent-system-task-assessment',
        path: '/installed/agent-system/skills/task-assessment/SKILL.md',
      },
    },
    resultContract: 'assessment-result/v1',
    resultSchema: assessmentResultContextSchema,
    presentationRequest: {
      action: 'assessment',
      operation: 'render',
      target: 'https://github.com/tanaabased/big-test-bucket/issues/123',
    },
    instructions: nativeAssessmentInstructions(runtime),
  };
}
