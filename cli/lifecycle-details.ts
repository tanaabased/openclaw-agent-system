import { openclawIntakeAutomationId } from '../agent/openclaw-intake-policy.ts';
import type { AgentSystemLifecyclePresentationItem } from '../core/lifecycle-presentation.ts';
import type { AgentManifest } from '../manifest/types.ts';

type LifecycleItem = AgentSystemLifecyclePresentationItem & {
  stepId?: string;
  remediation?: string;
};

function maskedId(value: string): string {
  return `***${value.slice(-4)}`;
}

/** human-only projection; retain raw lifecycle results and exact literal values in json. */
export default function lifecycleDetails(
  item: LifecycleItem,
  automations: NonNullable<AgentManifest['automations']>,
): AgentSystemLifecyclePresentationItem {
  const component =
    item.component === 'automations'
      ? 'automation'
      : item.component === 'session-dispatch'
        ? 'session-dispatch-credential'
        : item.component === 'github-intake'
          ? 'github-channel-intake'
          : item.component;
  let message = item.message;
  if (item.component === 'automations' && item.stepId) {
    const automation = automations.find(({ id }) => id === item.stepId);
    const name =
      automation?.thread?.name ??
      (item.stepId === openclawIntakeAutomationId
        ? 'ISSUE ASSIGNMENTS'
        : item.stepId.replaceAll('-', ' ').toUpperCase());
    message = message
      .replace(
        / \(persistent, ([^:]+): ([^)]+)\)/u,
        (_match, outcome: string, id: string) =>
          `; mode: persistent; thread: ${maskedId(id)}; outcome: ${outcome}`,
      )
      .replace(
        / \((created|bound|reused): ([^)]+)\)/u,
        (_match, outcome: string, id: string) =>
          `; mode: persistent; thread: ${maskedId(id)}; outcome: ${outcome}`,
      )
      .replace(' (independent)', '; mode: independent')
      .replace(`Automation ${item.stepId}: healthy`, () => `name: ${name}`)
      .replace(`Automation ${item.stepId}:`, () => `name: ${name}; condition:`)
      .replace(`Automation ${item.stepId} is synchronized`, () => `name: ${name}; synchronized`)
      .replace(`Automation ${item.stepId} is disabled`, () => `name: ${name}; disabled`);
  }
  if (item.component === 'session-dispatch') {
    message = message
      .replace(
        'Session dispatch credential verified using device-only authentication.',
        'name: Agent System; authentication: device-only; verified.',
      )
      .replace(/^Session dispatch/u, 'session dispatch');
  }
  if (item.component === 'github-intake') {
    message = message
      .replace(/^Intake baseline/u, 'intake baseline')
      .replace(/^V2 intake/u, 'intake')
      .replace(/^Intake /u, 'intake ');
  }
  const text = `${message}${item.remediation ? ` ${item.remediation}` : ''}`;
  const identifiers = [...text.matchAll(/\b(?:Device|request) ([A-Za-z0-9_-]{8,})/giu)].map(
    (match) => match[1]!,
  );
  const masked = identifiers.reduce((value, id) => value.replaceAll(id, maskedId(id)), text);
  return {
    component,
    status: item.status,
    message: masked.replace(/\bDevice (\*{3}[A-Za-z0-9_-]{4})/gu, 'device: $1'),
  };
}
