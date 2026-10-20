import publicResponseState, {
  type PublicResponseState,
} from '../../../agent/public-response-state.ts';
import { githubNotificationQuote } from './card.ts';

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
  const remedy = /skill/.test(input.code ?? '')
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
      ...(input.code ? ['', `**Diagnostic:** \`${input.code}\``] : []),
    ].join('\n'),
  );
}
