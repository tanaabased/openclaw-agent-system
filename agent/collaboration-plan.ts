import { isDeepStrictEqual } from 'node:util';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';

import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';

export type CollaborationSelection = 'all' | false | string[];
export interface CollaborationState {
  version: 1;
  selection: CollaborationSelection;
  ownedAgentIds: string[];
  explicit: boolean;
  disabledEmpty: boolean;
}

const agentIdPattern = /^[a-z0-9][a-z0-9-]*$/u;

function isAgentIds(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => typeof id === 'string' && agentIdPattern.test(id)) &&
    new Set(value).size === value.length
  );
}

function isSelection(value: unknown): value is CollaborationSelection {
  return value === 'all' || value === false || isAgentIds(value);
}

export function collaborationError(code: string, message: string): AgentSystemLifecycleError {
  return new AgentSystemLifecycleError('collaboration', `collaboration-${code}`, message);
}

/** read operator intent separately from the persisted ownership receipt. */
export function collaborationConfiguration(config: OpenClawConfig): {
  selection: CollaborationSelection;
  explicit: boolean;
  state?: CollaborationState;
} {
  const plugin = config.plugins?.entries?.['agent-system']?.config ?? {};
  const selection = plugin.collaboration === undefined ? 'all' : plugin.collaboration;
  if (!isSelection(selection))
    throw collaborationError(
      'invalid-selection',
      'Collaboration must be all, false, or a unique list of exact agent IDs.',
    );
  const state = plugin.collaborationState;
  if (state !== undefined) {
    if (
      !state ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      Reflect.get(state, 'version') !== 1 ||
      !isSelection(Reflect.get(state, 'selection')) ||
      !isAgentIds(Reflect.get(state, 'ownedAgentIds')) ||
      typeof Reflect.get(state, 'explicit') !== 'boolean' ||
      typeof Reflect.get(state, 'disabledEmpty') !== 'boolean'
    ) {
      throw collaborationError(
        'invalid-state',
        'Collaboration ownership state is invalid; no grants were changed.',
      );
    }
  }
  return {
    selection,
    explicit: plugin.collaboration !== undefined,
    ...(state === undefined ? {} : { state: state as CollaborationState }),
  };
}

/** plan only owned membership changes; an empty allowlist must never become allow-all. */
export default function planCollaboration(
  config: OpenClawConfig,
  managedAgentIds: readonly string[],
) {
  const { selection, explicit, state } = collaborationConfiguration(config);
  const members =
    selection === false
      ? []
      : [...managedAgentIds].filter((id) => selection === 'all' || selection.includes(id)).sort();
  const unavailableMembers = Array.isArray(selection)
    ? selection.filter((id) => !managedAgentIds.includes(id))
    : [];
  const previousAllow = config.tools?.agentToAgent?.allow;
  const allow = previousAllow ?? [];
  const owned = state?.ownedAgentIds ?? [];
  const removed = owned.filter((id) => !members.includes(id));
  const retained = allow.filter((id) => !removed.includes(id));
  const added = members.filter((id) => !retained.includes(id));
  const nextAllow = [...retained, ...added];
  const nextOwned = [
    ...owned.filter((id) => members.includes(id) && allow.includes(id)),
    ...added,
  ].sort();
  const configSelectionChanged =
    explicit && (!state || !state.explicit || !isDeepStrictEqual(selection, state.selection));
  const restrictedVisibility =
    config.tools?.sessions?.visibility !== undefined && config.tools.sessions.visibility !== 'all';
  const restrictedAccess =
    config.tools?.agentToAgent?.enabled === false && state?.disabledEmpty !== true;
  if (members.length && (restrictedVisibility || restrictedAccess) && !configSelectionChanged) {
    throw collaborationError(
      'host-restricted',
      'Explicit host restrictions block collaboration. Set the collaboration setting explicitly to migrate; after enrollment, install with collaboration=false before selecting the team again.',
    );
  }
  const next = structuredClone(config);
  const membershipChanged = !isDeepStrictEqual(allow, nextAllow);
  const emptiedOwnedList = membershipChanged && nextAllow.length === 0;
  if (members.length || membershipChanged) {
    next.tools ??= {};
    next.tools.agentToAgent ??= {};
    if (membershipChanged) next.tools.agentToAgent.allow = nextAllow;
    if (members.length) {
      next.tools.agentToAgent.enabled = true;
      next.tools.sessions = { ...next.tools.sessions, visibility: 'all' };
    } else if (emptiedOwnedList) {
      next.tools.agentToAgent.enabled = false;
    }
  }
  const nextState: CollaborationState = {
    version: 1,
    selection: structuredClone(selection),
    ownedAgentIds: nextOwned,
    explicit,
    disabledEmpty:
      (emptiedOwnedList && config.tools?.agentToAgent?.enabled !== false) ||
      (state?.disabledEmpty === true &&
        members.length === 0 &&
        next.tools?.agentToAgent?.enabled === false),
  };
  if (state || members.length) {
    next.plugins ??= {};
    next.plugins.entries ??= {};
    const plugin = (next.plugins.entries['agent-system'] ??= {});
    plugin.config = { ...plugin.config, collaborationState: nextState };
  }
  return {
    config: next,
    changed: !isDeepStrictEqual(config, next),
    members,
    unavailableMembers,
    operatorEntries: retained.filter((id) => !owned.includes(id)),
    ownedAgentIds: nextOwned,
  };
}
