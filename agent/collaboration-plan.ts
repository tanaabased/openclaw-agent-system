// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- the sdk omits declarations; every consuming ts project needs this ambient module.
/// <reference path="./native-session-policy.d.ts" />

import { isDeepStrictEqual } from 'node:util';

import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import {
  createAgentToAgentPolicy,
  resolveSessionToolsVisibility,
} from 'openclaw/plugin-sdk/session-visibility';

import { AgentSystemLifecycleError } from '../core/lifecycle-registry.ts';

export type CollaborationSelection = 'auto' | 'all' | false | string[];
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

function isOwnedGrants(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((id) => id === '*' || (typeof id === 'string' && agentIdPattern.test(id))) &&
    new Set(value).size === value.length
  );
}

function isSelection(value: unknown): value is CollaborationSelection {
  return value === 'auto' || value === 'all' || value === false || isAgentIds(value);
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
  const selection = plugin.collaboration === undefined ? 'auto' : plugin.collaboration;
  if (!isSelection(selection))
    throw collaborationError(
      'invalid-selection',
      'Collaboration must be auto, all, false, or a unique list of exact agent IDs.',
    );
  const state = plugin.collaborationState;
  if (state !== undefined) {
    if (
      !state ||
      typeof state !== 'object' ||
      Array.isArray(state) ||
      Reflect.get(state, 'version') !== 1 ||
      !isSelection(Reflect.get(state, 'selection')) ||
      !isOwnedGrants(Reflect.get(state, 'ownedAgentIds')) ||
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

/** reconcile required grants without adopting or withdrawing operator permissions. */
export default function planCollaboration(
  config: OpenClawConfig,
  selectedAgentIds: readonly string[],
) {
  const { selection, explicit, state } = collaborationConfiguration(config);
  const members =
    selection === false
      ? []
      : [...selectedAgentIds]
          .filter((id) => !Array.isArray(selection) || selection.includes(id))
          .sort();
  const unavailableMembers = Array.isArray(selection)
    ? selection.filter((id) => !selectedAgentIds.includes(id))
    : [];
  const allow = config.tools?.agentToAgent?.allow ?? [];
  const owned = state?.ownedAgentIds ?? [];
  const notApplicable = selection === 'auto' && members.length < 2 && owned.length === 0;
  const desired = selection === 'all' ? ['*'] : notApplicable ? [] : members;
  const removed = owned.filter((id) => !desired.includes(id));
  const retained = allow.filter((id) => !removed.includes(id));
  const retainedPolicy = createAgentToAgentPolicy({ tools: { agentToAgent: { allow: retained } } });
  const nativePolicy = createAgentToAgentPolicy(config);
  // an empty list resulting from cleanup or a disabled host is not an operator grant.
  const unrestricted = retained.length === 0 && removed.length === 0 && nativePolicy.enabled;
  const added = desired.filter(
    (id) => !unrestricted && !(retained.length > 0 && retainedPolicy.matchesAllow(id)),
  );
  const nextAllow = [...retained, ...added];
  const nextOwned = [
    ...owned.filter((id) => desired.includes(id) && allow.includes(id)),
    ...added,
  ].sort();
  const next = structuredClone(config);
  const membershipChanged = !isDeepStrictEqual(allow, nextAllow);
  const emptiedOwnedList = removed.length > 0 && nextAllow.length === 0;
  const wantsAccess = selection === 'all' || (!notApplicable && members.length > 0);
  if (
    membershipChanged ||
    emptiedOwnedList ||
    (wantsAccess && (!nativePolicy.enabled || resolveSessionToolsVisibility(config) !== 'all'))
  ) {
    next.tools ??= {};
    if (membershipChanged || emptiedOwnedList || (wantsAccess && !nativePolicy.enabled)) {
      next.tools.agentToAgent ??= {};
      if (membershipChanged || emptiedOwnedList) next.tools.agentToAgent.allow = nextAllow;
      if (wantsAccess) next.tools.agentToAgent.enabled = true;
      else if (emptiedOwnedList) next.tools.agentToAgent.enabled = false;
    }
    if (wantsAccess && resolveSessionToolsVisibility(config) !== 'all')
      next.tools.sessions = { ...next.tools.sessions, visibility: 'all' };
  }
  const nextState: CollaborationState = {
    version: 1,
    selection: structuredClone(selection),
    ownedAgentIds: nextOwned,
    explicit,
    disabledEmpty:
      emptiedOwnedList ||
      (state?.disabledEmpty === true &&
        !wantsAccess &&
        next.tools?.agentToAgent?.enabled === false),
  };
  if (state || nextOwned.length) {
    next.plugins ??= {};
    next.plugins.entries ??= {};
    const plugin = (next.plugins.entries['agent-system'] ??= {});
    plugin.config = { ...plugin.config, collaborationState: nextState };
  }
  const effectivePolicy = createAgentToAgentPolicy(next);
  const operatorEntries = retained.filter((id) => !owned.includes(id));
  const externalEntries = operatorEntries.filter((id) => !members.includes(id));
  const accessExpanded =
    wantsAccess &&
    (added.length > 0 || !nativePolicy.enabled || resolveSessionToolsVisibility(config) !== 'all');
  return {
    config: next,
    changed: !isDeepStrictEqual(config, next),
    members,
    unavailableMembers,
    notApplicable,
    operatorEntries,
    effectiveEntries:
      effectivePolicy.enabled && resolveSessionToolsVisibility(next) === 'all'
        ? nextAllow.length
          ? nextAllow
          : ['*']
        : [],
    connectedExternalEntries: accessExpanded ? (unrestricted ? ['*'] : externalEntries) : [],
    ownedAgentIds: nextOwned,
  };
}
