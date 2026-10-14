import { isAbsolute, relative } from 'node:path';

import githubNotificationCard, { githubNotificationMarkdownText } from './card.ts';

export interface WorkflowInstructionsSelection {
  defaultSkill: boolean;
  skill: { name: string; path?: string };
  guidance?: { source: 'inline' | 'file'; path?: string; content: string };
}

function fileLink(label: string, path?: string): string {
  const text = githubNotificationMarkdownText(label);
  if (!path || !isAbsolute(path) || /[\r\n\0]/u.test(path)) return text;
  const target = encodeURI(path).replace(/[?#<>]/gu, (value) => encodeURIComponent(value));
  return `[${text}](<${target}>)`;
}

/** show only retained overrides; a selection notice is not proof of model compliance. */
export default function workflowInstructions(
  stage: 'Assessment' | 'Implementation' | 'Feedback reply' | 'Review',
  selection?: WorkflowInstructionsSelection,
  workspace?: string,
): string | undefined {
  if (!selection) return;
  const { guidance, skill } = selection;
  const facts = [
    ...(!selection.defaultSkill
      ? [{ label: 'Skill', value: fileLink(skill.name, skill.path) }]
      : []),
    ...(guidance
      ? [
          {
            label: 'Guidance',
            value:
              guidance.source === 'inline'
                ? 'Inline guidance'
                : fileLink(
                    guidance.path && workspace && isAbsolute(guidance.path)
                      ? relative(workspace, guidance.path)
                      : (guidance.path ?? 'Guidance file'),
                    guidance.path,
                  ),
          },
        ]
      : []),
  ];
  if (!facts.length) return;
  const sections = [githubNotificationCard({ emoji: '🧩', title: `${stage} instructions`, facts })];
  if (guidance?.source === 'inline') {
    const fence = '`'.repeat(
      (guidance.content.match(/`+/gu) ?? []).reduce(
        (size, run) => Math.max(size, run.length + 1),
        3,
      ),
    );
    sections.push([fence + 'text', guidance.content.replace(/\r\n?/gu, '\n'), fence].join('\n'));
  }
  return sections
    .join('\n\n')
    .split('\n')
    .map((line) => '> ' + line)
    .join('\n');
}
