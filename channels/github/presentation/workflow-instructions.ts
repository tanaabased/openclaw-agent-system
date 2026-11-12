import { isAbsolute, relative, resolve } from 'node:path';

import { githubNotificationMarkdownCode, githubNotificationMarkdownText } from './card.ts';
import {
  defaultAssessmentSkill,
  defaultImplementationSkill,
  defaultFeedbackSkill,
  type AssessmentConfiguration,
} from '../../../manifest/assessment-schema.ts';
import debugCard from './debug.ts';

export interface WorkflowInstructionsSelection {
  defaultSkill: boolean;
  skill: { name: string; path?: string };
  guidance?: { source: 'inline' | 'file'; path?: string; content: string };
}

export interface WorkflowInstructionsPresentation {
  debug?: boolean;
  git?: {
    checkoutStartingPoint: { commit?: string; ref?: string };
    prBase?: string;
  };
  manifestPath?: string;
  workflow?: {
    assessment?: AssessmentConfiguration;
    implementation?: AssessmentConfiguration;
    feedback?: AssessmentConfiguration;
  };
}

export function fileLink(label: string, path?: string, literal = true): string {
  const text = literal
    ? githubNotificationMarkdownCode(label)
    : githubNotificationMarkdownText(label);
  if (!path || !isAbsolute(path) || /[\r\n\0]/u.test(path)) return text;
  const target = encodeURI(path).replace(/[?#<>]/gu, (value) => encodeURIComponent(value));
  return `[${text}](<${target}>)`;
}

/** debug shows retained selections; a notice is not proof of model compliance. */
export default function workflowInstructions(
  stage: 'Model routing' | 'Assessment' | 'Implementation' | 'Feedback reply' | 'Review',
  selection?: WorkflowInstructionsSelection,
  workspace?: string,
  presentation: WorkflowInstructionsPresentation = {},
): string | undefined {
  if (!presentation.debug || !selection) return;
  const { facts, sections } = workflowInstructionDetails(selection, workspace, presentation);
  return debugCard({
    debug: presentation.debug,
    context: `${stage} instructions`,
    facts,
    detail: sections.join('\n\n'),
  });
}

function workflowInstructionDetails(
  selection: WorkflowInstructionsSelection,
  workspace?: string,
  presentation: WorkflowInstructionsPresentation = {},
) {
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
  return { facts, sections };
}

/** configuration preview only: no discovery, reads, stage execution, or retained display state. */
export function workflowConfigurationCard(
  input: WorkflowInstructionsPresentation & {
    workspace?: string;
    routing?: WorkflowInstructionsSelection;
    assessment?: WorkflowInstructionsSelection;
    routingManifestPath?: string;
  },
) {
  if (!input.debug) return;
  const configured = (
    configuration: AssessmentConfiguration | undefined,
    fallback: string,
  ): WorkflowInstructionsSelection => ({
    defaultSkill: !configuration?.skill,
    skill: { name: configuration?.skill ?? fallback },
    ...(configuration?.guidance
      ? {
          guidance:
            typeof configuration.guidance === 'string'
              ? { source: 'inline' as const, content: configuration.guidance }
              : {
                  source: 'file' as const,
                  content: '',
                  path: input.workspace
                    ? resolve(input.workspace, configuration.guidance.file)
                    : configuration.guidance.file,
                },
        }
      : {}),
  });
  const stages: Array<[string, WorkflowInstructionsSelection | undefined, string | undefined]> = [
    ['Model routing', input.routing, input.routingManifestPath ?? input.manifestPath],
    [
      'Assessment',
      input.assessment ??
        (input.workflow && configured(input.workflow.assessment, defaultAssessmentSkill)),
      input.manifestPath,
    ],
    [
      'Implementation',
      input.workflow && configured(input.workflow.implementation, defaultImplementationSkill),
      input.manifestPath,
    ],
    [
      'Feedback reply',
      input.workflow && configured(input.workflow.feedback, defaultFeedbackSkill),
      input.manifestPath,
    ],
  ];
  const sections = stages.flatMap(([stage, selection, manifestPath]) => {
    if (!selection) return [];
    const detail = workflowInstructionDetails(selection, input.workspace, { manifestPath });
    return [
      `### ${stage} instructions`,
      detail.facts.map(({ label, value }) => `- **${label}:** ${value}`).join('\n'),
      ...detail.sections,
    ];
  });
  if (!sections.length) return;
  return debugCard({
    debug: true,
    context: 'Configured workflow',
    facts: input.git && [
      {
        label: 'Checkout starting point',
        value: githubNotificationMarkdownCode(
          `${input.git.checkoutStartingPoint.commit ?? 'unknown'} (${input.git.checkoutStartingPoint.ref ?? 'unknown'})`,
        ),
      },
      { label: 'PR base', value: githubNotificationMarkdownCode(input.git.prBase ?? 'unknown') },
    ],
    detail: [
      'Configured skills and guidance; this is not proof that a skill ran or its instructions were followed.',
      ...sections,
    ].join('\n\n'),
  });
}
