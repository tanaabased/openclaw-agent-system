/** questions belong to the current native turn, not a saved workflow result. */
export default function nativeClarification(id: string, presentation: string) {
  return {
    status: 'native' as const,
    id,
    outcome: 'clarification-needed' as const,
    presentation,
    instruction:
      'Show these questions in the native chat. When publication is authorized, use Task Update independently. Continue independently useful work; wait for the answer where needed. The answer is ordinary native input. No clarification result, phase, or resume checkpoint was saved.',
  };
}
