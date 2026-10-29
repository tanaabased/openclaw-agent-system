import { openclawIntakeAutomationId } from '../agent/openclaw-intake-policy.ts';
import {
  automationSettingsMessage,
  type AutomationThreadModelObservation,
} from '../agent/automation-threads.ts';
import type { AgentSystemLifecyclePresentationItem } from '../core/lifecycle-presentation.ts';
import type { AgentManifest } from '../manifest/types.ts';

type LifecycleItem = AgentSystemLifecyclePresentationItem & {
  stepId?: string;
  remediation?: string;
  code?: string;
  settings?: AutomationThreadModelObservation;
};

function maskedId(value: string): string {
  return `***${value.slice(-4)}`;
}

/** human-only projection; retain raw lifecycle results and exact literal values in json. */
export default function lifecycleDetails(
  item: LifecycleItem,
  automations: NonNullable<AgentManifest['automations']>,
  agentId?: string,
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
  if (item.stepId && item.component !== 'automations') message = `id: ${item.stepId}; ${message}`;
  else if (agentId && ['agent', 'tool-access'].includes(item.component))
    message = `id: ${agentId}; ${message}`;
  else if (item.code === 'tool-executables-unavailable')
    message = `tool: ${item.component}; ${message}`;
  if (item.component === 'instance-identity')
    message = message.replace(
      /\bid: ([a-f0-9-]{36})/gu,
      (_match, id: string) => `id: ${maskedId(id)}`,
    );
  if (item.component === 'automations' && item.stepId) {
    const automation = automations.find(({ id }) => id === item.stepId);
    const name =
      automation?.thread?.name ??
      (item.stepId === openclawIntakeAutomationId
        ? 'ISSUE ASSIGNMENTS'
        : item.stepId.replaceAll('-', ' ').toUpperCase());
    if (item.settings) {
      const comparison = automationSettingsMessage(item.settings);
      message = message.replace(`${comparison}; `, '').replace(`; ${comparison}`, '');
    }
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
      .replace('removal-pending', 'pause pending; native job retained')
      .replace(' (independent)', '; mode: independent')
      .replace(`Automation ${item.stepId}: healthy`, () => `name: ${name}`)
      .replace(`Automation ${item.stepId}:`, () => `name: ${name}; condition:`)
      .replace(`Automation ${item.stepId} is synchronized`, () => `name: ${name}; synchronized`)
      .replace(`Automation ${item.stepId} is disabled`, () => `name: ${name}; disabled`);
    if (!message.startsWith(`name: ${name}`)) message = `name: ${name}; condition: ${message}`;
    if (
      item.settings &&
      item.status !== 'healthy' &&
      item.code &&
      /(?:model|effort|settings)/u.test(item.code)
    ) {
      const settings = item.settings;
      const unsupported =
        item.code === 'automation-model-unsupported'
          ? 'model'
          : item.code === 'automation-effort-unsupported'
            ? 'effort'
            : undefined;
      const details = (['model', 'effort'] as const).flatMap((key) => {
        const requested = settings.requested[key];
        if (
          requested === undefined ||
          (unsupported !== undefined && key !== unsupported) ||
          (item.code === 'automation-thread-model-drift' && requested === settings.observed[key])
        )
          return [];
        return [
          `${key}: requested: ${requested}; observed: ${settings.observed[key] ?? 'native/unknown'}`,
        ];
      });
      if (details.length) message += `; ${details.join('; ')}`;
    }
  }
  if (item.component === 'session-dispatch') {
    message = message
      .replace(
        'Session dispatch credential verified using device-only authentication.',
        'name: Agent System; authentication: device-only; verified.',
      )
      .replace(/^Session dispatch/u, 'session dispatch');
    if (!message.startsWith('name: Agent System')) message = `name: Agent System; ${message}`;
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
