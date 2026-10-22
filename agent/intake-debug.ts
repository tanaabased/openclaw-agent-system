import type { Retirement } from './assignment-retirement.ts';
import debugCard from '../channels/github/presentation/debug.ts';
import { githubNotificationMarkdownText as text } from '../channels/github/presentation/card.ts';

/** missing stored evidence is diagnostic, never proof of remaining resources or cleanup. */
export default function intakeDebug<
  T extends { retired?: unknown; retirement?: Retirement; reset?: unknown },
>(
  debug: boolean | undefined,
  records: readonly T[],
  label: (record: T) => string,
): string | undefined {
  const historical = records.filter(
    (record) =>
      !record.reset &&
      record.retired &&
      (record.retirement?.worktreeRemovedAt === undefined ||
        (record.retirement.archivedAt === undefined &&
          !record.retirement.sessionUnavailableObserved)),
  );
  return debugCard({
    debug,
    context: 'Intake — historical cleanup evidence',
    ...(historical.length
      ? {
          facts: historical
            .slice(0, 12)
            .map((record) => ({ label: 'Issue', value: text(label(record)) })),
          detail:
            'Stored archive or removal evidence is absent for ' +
            historical.length +
            ' historical record(s) (retirement-legacy-unverified). This establishes neither remaining live resources nor successful cleanup.',
        }
      : {}),
  });
}
