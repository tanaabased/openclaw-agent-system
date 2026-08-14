import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

import {
  GitHubNotificationPublicationError,
  githubNotificationPublicationText,
} from './publication.ts';
import {
  githubNotificationMarkdownResponse,
  githubNotificationPublicCandidates,
} from './response-presentation.ts';

const fallbackAcknowledgment = 'Got it — I have reviewed the assignment and prepared a plan.';
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
  const markdown = githubNotificationMarkdownResponse(response);
  const lines = markdown.lines;
  const sections: PlanningSection[] = [];
  const formats = new Set<PlanningResponseFormat>();

  for (const { line: lineNumber, text } of markdown.visibleLines) {
    const section = planningSection(text);
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
  for (const [index, section] of sections.entries()) {
    const end = sections[index + 1]?.line ?? lines.length;
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

/** Extract only the explicit public candidate from an otherwise private planning response. */
export default function githubNotificationPlanningAcknowledgment(
  payloads: readonly ReplyPayload[],
): string {
  const candidates = payloads.flatMap((payload) =>
    githubNotificationPublicCandidates(planningResponseText(payload), 'ACKNOWLEDGMENT'),
  );
  if (candidates.length !== 1 || !candidates[0]?.value) {
    return githubNotificationPublicationText('initial-acknowledgment', [
      { text: fallbackAcknowledgment },
    ]);
  }
  try {
    return githubNotificationPublicationText('initial-acknowledgment', [
      { text: candidates[0].value },
    ]);
  } catch (error) {
    if (!(error instanceof GitHubNotificationPublicationError)) throw error;
    return githubNotificationPublicationText('initial-acknowledgment', [
      { text: fallbackAcknowledgment },
    ]);
  }
}
