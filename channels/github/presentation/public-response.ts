import publicResponseState, {
  type PublicResponseState,
} from '../../../agent/public-response-state.ts';
import { githubNotificationMarkdownCode, githubNotificationQuote } from './card.ts';

/** successful publication uses the existing linked attribution, not another success card. */
export default function publicResponsePresentation(
  input: PublicResponseState & {
    kind: string;
    destination?: string;
  },
) {
  const state = publicResponseState(input);
  if (state === 'delivered') return '';
  const title =
    state === 'unconfirmed'
      ? 'unconfirmed'
      : state === 'blocked'
        ? 'needs attention'
        : state === 'withheld'
          ? 'withheld'
          : 'pending';
  const remedy =
    input.code === 'github-delivery-closing-reference-missing'
      ? 'Inspect the existing PR’s closing reference and intended issue association, then continue in this chat after correcting it. No link was added automatically.'
      : input.code === 'github-delivery-linkage-observation-invalid'
        ? 'GitHub returned invalid issue-link evidence. Inspect the provider diagnostic and the existing PR, then continue in this chat.'
        : input.code === 'github-delivery-linkage-unverified'
          ? 'GitHub has not observed the closing issue association. Keep the existing PR; recovery checks use backoff and stop after a bounded budget.'
          : /skill/.test(input.code ?? '')
            ? 'Restore the configured reply skill, then compose again in this chat.'
            : /denied|cancel/.test(input.code ?? '')
              ? 'Publication is stopped. Continue only after the denial or cancellation is explicitly resolved.'
              : /credential|authentication|permission|forbidden/.test(input.code ?? '')
                ? 'Restore the required GitHub access, then continue in this chat.'
                : /policy/.test(input.code ?? '')
                  ? 'Automatic publication is paused by current policy; pending work remains saved.'
                  : 'Resolve the named obstacle, then continue in this same chat. Do not bypass a denial or changed source.';
  const next =
    state === 'unconfirmed'
      ? 'Check for the exact existing post before sending anything again. Do not repost an uncertain response.'
      : state === 'blocked'
        ? remedy
        : state === 'withheld'
          ? 'No public response will be sent.'
          : 'Continue the unfinished response in this chat; completed work remains saved.';
  return githubNotificationQuote(
    [
      `## ${state === 'pending' || state === 'withheld' ? '💡' : '⚠️'} ${input.kind} ${title}`,
      '',
      'The private result and any retained draft remain saved.',
      ...(input.destination ? ['', `**Destination:** [GitHub ↗](${input.destination})`] : []),
      '',
      `**Next:** ${next}`,
      ...(input.code ? ['', '**Diagnostic:** ' + githubNotificationMarkdownCode(input.code)] : []),
    ].join('\n'),
  );
}
