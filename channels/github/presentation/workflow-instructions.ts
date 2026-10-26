import { isAbsolute, relative } from 'node:path';

import { githubNotificationMarkdownCode, githubNotificationMarkdownText } from './card.ts';
import debugCard from './debug.ts';

export interface WorkflowInstructionsSelection {
  defaultSkill: boolean;
  skill: { name: string; path?: string };
  guidance?: { source: 'inline' | 'file'; path?: string; content: string };
}

export interface WorkflowInstructionsPresentation {
  debug?: boolean;
  manifestPath?: string;
}

function fileLink(label: string, path?: string, literal = true): string {
  const text = literal
    ? githubNotificationMarkdownCode(label)
    : githubNotificationMarkdownText(label);
  if (!path || !isAbsolute(path) || /[\r\n\0]/u.test(path)) return text;
  const target = encodeURI(path).replace(/[?#<>]/gu, (value) => encodeURIComponent(value));
  return `[${text}](<${target}>)`;
}

/** debug shows retained selections; a notice is not proof of model compliance. */
export default function workflowInstructions(
  stage: 'Assessment' | 'Implementation' | 'Feedback reply' | 'Review',
  selection?: WorkflowInstructionsSelection,
  workspace?: string,
  presentation: WorkflowInstructionsPresentation = {},
): string | undefined {
  if (!presentation.debug || !selection) return;
  const { guidance, skill } = selection;
  const facts = [
    {
      label: 'Skill',
      value: fileLink(skill.name, skill.path) + (selection.defaultSkill ? ' (default)' : ''),
    },
    ...(guidance
      ? [
          {
            label: 'Guidance',
            value:
              guidance.source === 'inline'
                ? fileLink('Inline guidance', presentation.manifestPath, false)
                : fileLink(
                    guidance.path && workspace && isAbsolute(guidance.path)
                      ? relative(workspace, guidance.path)
                      : (guidance.path ?? 'Guidance file'),
                    guidance.path,
                    !!guidance.path,
                  ),
          },
        ]
      : []),
  ];
  const sections: string[] = [];
  if (guidance?.source === 'inline') {
    const fence = '`'.repeat(
      (guidance.content.match(/`+/gu) ?? []).reduce(
        (size, run) => Math.max(size, run.length + 1),
        3,
      ),
    );
    sections.push([fence + 'text', guidance.content.replace(/\r\n?/gu, '\n'), fence].join('\n'));
  }
  return debugCard({
    debug: presentation.debug,
    context: `${stage} instructions`,
    facts,
    detail: sections.join('\n\n'),
  });
}
