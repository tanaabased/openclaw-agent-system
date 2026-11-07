import debugCard from '../channels/github/presentation/debug.ts';

/** presentation guidance only; recovery and permission remain with their existing owners. */
export default function workflowNoticeInstructions(includeTemplate = false) {
  const instructions =
    'In the final response, show unresolved obstacles privately using notice.message or delivery notices, even with debug off. Preserve severity: ⚠️ means an actionable obstacle or uncertain outcome; ❌ means a failed operation, not necessarily a failed task. Without a returned card, use a quoted heading and What happened, Next step and safe Technical detail facts. Questions and ordinary pending work are not failures. After verified recovery, replace the resolved obstacle with a 🔬 Debug card only when debug is enabled: Context, What happened, Outcome, Technical detail. Include only observed attempt counts and intervention; never infer recovery from a planned retry. Preserve unresolved obstacles and native denials; reconcile uncertain writes. Do not expose secrets or raw diagnostics.';
  if (!includeTemplate) return instructions;
  return [
    instructions,
    'Use this existing card style, replacing placeholders with verified observations:',
    debugCard({
      debug: true,
      context: '<affected operation> recovery',
      facts: [
        { label: 'What happened', value: '<observed failures and successful recovery>' },
        { label: 'Outcome', value: '<verified result and any remaining action>' },
        { label: 'Technical detail', value: '`<safe diagnostic code>`' },
      ],
    })!,
  ].join('\n\n');
}
