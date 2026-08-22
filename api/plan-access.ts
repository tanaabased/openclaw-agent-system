export type AgentToolAccessTarget = 'allow' | 'alsoAllow';

export interface AgentToolAccessGrants {
  desired: readonly string[];
  owned: readonly string[];
}

export interface AgentToolAccessLists {
  allow?: string[];
  alsoAllow?: string[];
}

export type CurrentAgentToolAccessState =
  | { exists: false }
  | {
      exists: true;
      allow?: readonly string[];
      alsoAllow?: readonly string[];
      deny?: readonly string[];
    };

export type AgentToolAccessPlan =
  | { status: 'missing-agent' }
  | {
      changed: boolean;
      denied: string[];
      desired: string[];
      misplaced: string[];
      missing: string[];
      next: AgentToolAccessLists;
      stale: string[];
      status: 'ready';
      target: AgentToolAccessTarget;
    };

function normalizedToolName(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueToolNames(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = normalizedToolName(value);
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function matchesToolPolicyPattern(toolName: string, pattern: string): boolean {
  const normalizedName = normalizedToolName(toolName);
  const normalizedPattern = normalizedToolName(pattern);
  if (!normalizedPattern) return false;
  if (!normalizedPattern.includes('*')) return normalizedName === normalizedPattern;
  const expression = normalizedPattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`).test(normalizedName);
}

/** Compare registry-owned grants with both per-agent allowlists without changing explicit denies. */
export default function planAgentToolAccess(
  grants: AgentToolAccessGrants,
  current: CurrentAgentToolAccessState,
): AgentToolAccessPlan {
  if (!current.exists) return { status: 'missing-agent' };

  const owned = uniqueToolNames(grants.owned);
  const ownedByName = new Map(owned.map((name) => [normalizedToolName(name), name]));
  const desired = uniqueToolNames(grants.desired).filter((name) =>
    ownedByName.has(normalizedToolName(name)),
  );
  const desiredNames = new Set(desired.map(normalizedToolName));
  const isOwned = (name: string) => ownedByName.has(normalizedToolName(name));
  const canonicalOwnedNames = (names: readonly string[]) =>
    uniqueToolNames(
      names.flatMap((name) => {
        const canonical = ownedByName.get(normalizedToolName(name));
        return canonical === undefined ? [] : [canonical];
      }),
    );

  const target: AgentToolAccessTarget = current.allow === undefined ? 'alsoAllow' : 'allow';
  const other: AgentToolAccessTarget = target === 'allow' ? 'alsoAllow' : 'allow';
  const targetEntries = [...(current[target] ?? [])];
  const otherEntries = [...(current[other] ?? [])];
  const targetOwned = targetEntries.filter(isOwned);
  const otherOwned = otherEntries.filter(isOwned);
  const missing = desired.filter(
    (name) => !targetOwned.some((entry) => normalizedToolName(entry) === normalizedToolName(name)),
  );
  const stale = canonicalOwnedNames([...targetOwned, ...otherOwned]).filter(
    (name) => !desiredNames.has(normalizedToolName(name)),
  );
  const misplaced = canonicalOwnedNames(otherOwned).filter((name) =>
    desiredNames.has(normalizedToolName(name)),
  );
  const changed =
    targetOwned.length !== desired.length ||
    otherOwned.length > 0 ||
    missing.length > 0 ||
    stale.length > 0;
  const nextTarget = changed
    ? [...targetEntries.filter((name) => !isOwned(name)), ...desired]
    : targetEntries;
  const nextOther = changed ? otherEntries.filter((name) => !isOwned(name)) : otherEntries;
  const next: AgentToolAccessLists = {
    ...(current.allow === undefined && target !== 'allow'
      ? {}
      : { allow: target === 'allow' ? nextTarget : nextOther }),
    ...(current.alsoAllow === undefined && target !== 'alsoAllow'
      ? {}
      : { alsoAllow: target === 'alsoAllow' ? nextTarget : nextOther }),
  };
  const denied = desired.filter((name) =>
    (current.deny ?? []).some((pattern) => matchesToolPolicyPattern(name, pattern)),
  );

  return {
    changed,
    denied,
    desired,
    misplaced,
    missing,
    next,
    stale,
    status: 'ready',
    target,
  };
}
