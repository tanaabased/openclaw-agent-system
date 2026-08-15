import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import { githubNotificationToGitHubHeading } from '../messages/presentation/response-envelope.ts';
import {
  GitHubNotificationPublicationError,
  githubNotificationPublicationText,
} from './publication.ts';
import githubNotificationQuotedCandidate, {
  githubNotificationMarkdownHeadings,
} from './quoted-candidate.ts';

const requiredSections = ['ASSESSMENT', 'BLOCKERS', 'PLAN'] as const;

type PlanningResponseFormat = 'legacy' | 'markdown';
type PlanningSectionName = (typeof requiredSections)[number];

interface PlanningSection {
  line: number;
  name: PlanningSectionName;
}

export class GitHubNotificationPlanningResponseError extends Error {
  override name = 'GitHubNotificationPlanningResponseError';

  constructor(readonly code: string) {
    super('The GitHub notification planning response did not contain one complete supported plan.');
  }
}

function planningResponseText(payload: ReplyPayload): string {
  return payload.text?.trim() ?? '';
}

function planningSection(
  line: string,
): { format: PlanningResponseFormat; name: PlanningSectionName } | undefined {
  const markdown = /^##[ \t]+(Assessment|Blockers|Plan)[ \t]*$/u.exec(line);
  if (markdown?.[1]) {
    return { format: 'markdown', name: markdown[1].toUpperCase() as PlanningSectionName };
  }
  const legacy = /^(ASSESSMENT|BLOCKERS|PLAN):[ \t]*$/u.exec(line);
  return legacy?.[1] ? { format: 'legacy', name: legacy[1] as PlanningSectionName } : undefined;
}

function planningSections(response: string): {
  format: PlanningResponseFormat;
  lines: string[];
  sections: PlanningSection[];
} {
  const lines = response.replace(/\r\n?/gu, '\n').split('\n');
  const sections: PlanningSection[] = [];
  const formats = new Set<PlanningResponseFormat>();
  let fence: { character: '`' | '~'; length: number } | undefined;

  for (const [lineNumber, line] of lines.entries()) {
    const marker = /^[ \t]{0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (
        marker?.[0] === fence.character &&
        marker.length >= fence.length &&
        line.slice(marker.length).trim() === ''
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = { character: marker[0] as '`' | '~', length: marker.length };
      continue;
    }
    const section = planningSection(line);
    if (!section) continue;
    formats.add(section.format);
    sections.push({ line: lineNumber, name: section.name });
  }

  if (formats.size !== 1) {
    throw new GitHubNotificationPlanningResponseError(
      'github-notification-planning-response-invalid',
    );
  }
  return { format: [...formats][0]!, lines, sections };
}

function assertPlanningSections(response: string): void {
  const { format, lines, sections } = planningSections(response);
  if (sections.map(({ name }) => name).join(',') !== requiredSections.join(',')) {
    throw new GitHubNotificationPlanningResponseError(
      'github-notification-planning-response-invalid',
    );
  }
  const planSection = sections[sections.length - 1]!;
  const publicHeading = githubNotificationMarkdownHeadings(lines).find(
    ({ line, text }) =>
      text === githubNotificationToGitHubHeading &&
      format === 'markdown' &&
      planSection.line < line,
  );
  for (const [index, section] of sections.entries()) {
    const end = sections[index + 1]?.line ?? publicHeading?.line ?? lines.length;
    const content = lines
      .slice(section.line + 1, end)
      .join('\n')
      .trim();
    if (!content) {
      throw new GitHubNotificationPlanningResponseError(
        'github-notification-planning-response-invalid',
      );
    }
    if (
      format === 'markdown' &&
      section.name === 'PLAN' &&
      !/^[ \t]{0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+\S/mu.test(content)
    ) {
      throw new GitHubNotificationPlanningResponseError(
        'github-notification-planning-response-invalid',
      );
    }
  }
}

function assertPlanningPublicReply(response: string): string {
  const { format, lines, sections } = planningSections(response);
  const publicHeadings = githubNotificationMarkdownHeadings(lines).filter(
    ({ text }) => text === githubNotificationToGitHubHeading,
  );
  const publicHeading = publicHeadings[0];
  if (
    format !== 'markdown' ||
    publicHeadings.length !== 1 ||
    !publicHeading ||
    publicHeading.line <= sections[sections.length - 1]!.line
  ) {
    throw new GitHubNotificationPlanningResponseError('github-notification-planning-reply-invalid');
  }
  try {
    return githubNotificationPublicationText('planning-outcome', [
      {
        text: githubNotificationQuotedCandidate(response, githubNotificationToGitHubHeading),
      },
    ]);
  } catch (error) {
    if (error instanceof GitHubNotificationPublicationError) throw error;
    throw new GitHubNotificationPlanningResponseError('github-notification-planning-reply-invalid');
  }
}

function hasPlanningSections(payload: ReplyPayload): boolean {
  try {
    assertPlanningSections(planningResponseText(payload));
    return true;
  } catch {
    return false;
  }
}

/** Select one complete private planning reply, preferring an ordinary final over commentary. */
export function assertGitHubNotificationPlanningResponse(
  payloads: readonly ReplyPayload[],
): ReplyPayload {
  const textPayloads = payloads.filter((payload) => planningResponseText(payload));
  if (textPayloads.length === 0) {
    throw new GitHubNotificationPlanningResponseError(
      'github-notification-planning-response-missing',
    );
  }
  const completePayloads = textPayloads.filter(hasPlanningSections);
  const ordinaryPayloads = completePayloads.filter(({ isCommentary }) => isCommentary !== true);
  const candidates =
    ordinaryPayloads.length > 0
      ? ordinaryPayloads
      : completePayloads.filter(({ isCommentary }) => isCommentary === true);
  if (candidates.length !== 1 || !candidates[0]) {
    throw new GitHubNotificationPlanningResponseError(
      'github-notification-planning-response-invalid',
    );
  }
  return candidates[0];
}

/** Extract the one safe quoted GitHub planning outcome from a validated private response. */
export function githubNotificationPlanningReply(payload: ReplyPayload): string {
  const response = planningResponseText(payload);
  assertPlanningSections(response);
  return assertPlanningPublicReply(response);
}
