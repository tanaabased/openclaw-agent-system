import { assessmentPresentationRequest } from '../agent/tasks/assessment/assessment-render.ts';
import dispatchContext from '../agent/tasks/dispatch/dispatch-context.ts';
import resolveModelRoutingRequest from '../agent/model-routing-request.ts';
import {
  nativeRoutingMetadata,
  routingMetadata,
} from '../channels/github/provider/routing-metadata.ts';
import { nativeAssessmentInstructions } from '../agent/tasks/assessment/assessment-instructions.ts';
import { assessmentResultContextSchema } from '../agent/tasks/assessment/assessment-result.ts';

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
      id: 'a'.repeat(64),
      ...assessmentPresentationRequest('https://github.com/tanaabased/big-test-bucket/issues/123'),
    },
    instructions: nativeAssessmentInstructions(),
  };
}

export function hostedAssessmentContextFixture() {
  const base = assessmentContextFixture();
  const body = 'A small documentation change. '.repeat(12);
  const metadata = nativeRoutingMetadata([]);
  const workspace =
    '/home/runner/work/openclaw-agent-system/openclaw-agent-system/examples/openclaw-notifications-reset/tanaabot/.agent-system/worktrees/github-1329940218-5df4e82369/issue-6245477254-fbe20edef4';
  return {
    ...base,
    project: { path: workspace },
    routing: resolveModelRoutingRequest(
      { default: { model: 'aimock/gpt-5.5', effort: 'medium' } },
      'c'.repeat(64),
      {
        action: 'resolve',
        context: 'test',
        fallback: 'default',
        assessment: { complexity: 'low', reason: 'A bounded disposable documentation plan.' },
      },
      'openclaw',
    ),
    effective: { model: 'aimock/gpt-5.5', thinkingLevel: 'medium', workspace },
    executionEffort: 'unverified',
    evidence: dispatchContext(
      {
        title: 'DOCUMENT DISPOSABLE TEST ISSUE CLEANUP',
        body,
        comments: [],
        labels: [],
        truncated: false,
        nativeRoutingMetadata: metadata,
        routingMetadata: routingMetadata(metadata, body),
      },
      'https://github.com/tanaabased/big-test-bucket/issues/15195',
      1,
    ),
    assessment: {
      version: 1,
      requestedSkill: 'agent-system:agent-system-task-assessment',
      defaultSkill: true,
      observedAt: 1,
      skill: {
        ...base.assessment.skill,
        path: '/home/runner/work/_temp/openclaw-context.test/openclaw/extensions/agent-system/skills/task-assessment/SKILL.md',
        scope: 'openclaw-bundled',
        digest: 'b'.repeat(64),
      },
    },
  };
}
