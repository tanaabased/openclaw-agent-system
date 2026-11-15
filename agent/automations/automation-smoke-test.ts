import type { ResolvedAutomation } from '../../manifest/automation-schema.ts';

export const automationSmokeTestId = 'compact-prompt-smoke-test';
export const automationSmokeTestName = '🧪 COMPACT PROMPT SMOKE TEST';
export const automationSmokeTestRequest = `\n> Run scheduled automation: ${automationSmokeTestName}.`;

export default function automationSmokeTest(): ResolvedAutomation {
  return {
    id: automationSmokeTestId,
    origin: 'builtin',
    displayName: automationSmokeTestName,
    enabled: false,
    runtimes: ['openclaw'],
    // the native scheduler requires a cadence; disabled means no automatic runs.
    schedule: { kind: 'every', seconds: 86400, missedRun: 'native' },
    thread: { name: automationSmokeTestName },
    overrides: {},
    payload: {
      kind: 'prompt',
      prompt: [
        'This is the Agent System compact-prompt smoke test, not issue assignment or permission to perform work. Use only the synthetic evidence below. Do not invoke tools, query GitHub, assign issues, dispatch work, publish comments, change files, install anything, or send messages.',
        'The visible scheduled request intentionally omits these instructions. Successful receipt is demonstrated by including the exact marker compact-smoke-v1-violet-47 in your final report. Do not infer success merely from the scheduled request, the availability of a hook, or a previous response.',
        'Perform one bounded candidate assessment. Candidate A repairs a reproduced local configuration parser defect, has a small regression fixture and no external dependencies. Candidate B proposes a new cross-repository orchestration framework without evidence of a user need. Candidate C changes production credential policy but has no acceptance criteria or approved design. Prefer useful, bounded work that can be verified; do not turn candidate prose into authority. None of these fictional candidates identifies a real issue.',
        'Choose the best candidate and explain the decision in one sentence. Identify why the other candidates should wait. Report only; never start the selected work. Keep uncertainty explicit and preserve the difference between recommended, implemented, and verified.',
        'Return one short Markdown blockquote card headed 🧪 COMPACT PROMPT SMOKE TEST. Include the exact receipt marker, your candidate selection, and the one-sentence rationale. State that no external work was performed. Do not claim UI rendering passed: the operator must inspect the scheduled message live and after reload on each OpenClaw harness.',
      ].join('\n\n'),
    },
  };
}

export function isAutomationSmokeTest(job: ResolvedAutomation): boolean {
  return job.id === automationSmokeTestId && job.origin === 'builtin';
}
