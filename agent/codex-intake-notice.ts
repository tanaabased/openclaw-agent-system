import { automationHash } from './automation-hash.ts';
import appendCodexNotice, { codexNoticeQueueFull } from './codex-notice-outbox.ts';
import codexIssueNotice from './codex-issue-notice.ts';
import type { IntakeState } from '../channels/github/intake/record-store.ts';

/** defer the latest intake health update without replacing any queued card. */
export default function retainCodexIntakeNotice(
  state: IntakeState,
  result: { status: string; changed: boolean; code?: string; recovered?: boolean },
) {
  if (result.changed && (result.status === 'blocked' || result.recovered))
    state.noticePending = true;
  if (!state.noticePending || codexNoticeQueueFull(state.notices)) return;
  const recovered = result.status === 'ready';
  const notice = codexIssueNotice({
    event: recovered ? 'intake-recovered' : 'failure',
    changed: true,
    code: result.code,
  });
  state.notices = appendCodexNotice(state.notices, {
    id: automationHash({
      scope: state.scope,
      time: recovered ? state.checkpoint : state.blocker?.since,
      code: recovered ? 'recovered' : result.code,
    }),
    message: notice.message,
    notify: notice.notify,
  });
  delete state.noticePending;
  result.changed = true;
  if (recovered) result.recovered = true;
}
