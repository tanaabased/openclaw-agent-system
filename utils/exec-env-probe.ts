import { createHash, randomUUID } from 'node:crypto';

import type { AgentEnvironmentVariable } from './resolve-agent-environment.ts';

const probeResultMarker = 'AGENT_SYSTEM_ENV_PROBE_RESULT=';
const probeSessionPrefix = 'agent-system-env-probe-';
const portableEnvironmentName = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ExecEnvironmentProbe {
  agentId: string;
  command: string;
  idempotencyKey: string;
  nonce: string;
  sessionKey: string;
  variables: AgentEnvironmentVariable[];
}

export interface ObservedExecEnvironmentVariable extends AgentEnvironmentVariable {
  observedExecDelivery: 'accepted' | 'filtered';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sentinel(nonce: string, name: string): string {
  const digest = createHash('sha256').update(nonce).update('\0').update(name).digest('hex');
  return `agent-system-env-probe-${digest}`;
}

function probeScript(): string {
  return [
    "const entries=JSON.parse(Buffer.from(process.argv[1],'base64url').toString('utf8'));",
    'const accepted=entries.filter(([name,value])=>process.env[name]===value).map(([name])=>name);',
    `process.stdout.write('${probeResultMarker}'+Buffer.from(JSON.stringify(accepted)).toString('base64url'));`,
  ].join('');
}

export function parseExecEnvironmentProbeSession(
  sessionKey: string | undefined,
): { agentId: string; nonce: string } | undefined {
  if (!sessionKey) return undefined;
  const match = /^agent:([^:]+):agent-system-env-probe-([a-f0-9-]{36})$/.exec(sessionKey);
  if (!match?.[1] || !match[2]) return undefined;
  return { agentId: match[1], nonce: match[2] };
}

export function resolveExecEnvironmentProbeValues(
  sessionKey: string | undefined,
  agentId: string,
  variables: AgentEnvironmentVariable[],
): Record<string, string> | undefined {
  const probe = parseExecEnvironmentProbeSession(sessionKey);
  if (!probe || probe.agentId !== agentId) return undefined;
  return Object.fromEntries(variables.map(({ name }) => [name, sentinel(probe.nonce, name)]));
}

export function createExecEnvironmentProbe(
  agentId: string,
  variables: AgentEnvironmentVariable[],
  options: { nodePath?: string; nonce?: string } = {},
): ExecEnvironmentProbe {
  const nonce = options.nonce ?? randomUUID();
  const nodePath = options.nodePath ?? 'node';
  const normalizedVariables = variables.toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const { name } of normalizedVariables) {
    if (!portableEnvironmentName.test(name)) {
      throw new Error(`Cannot probe invalid environment variable name: ${name}`);
    }
  }
  const entries = normalizedVariables.map(({ name }) => [name, sentinel(nonce, name)]);
  const payload = Buffer.from(JSON.stringify(entries)).toString('base64url');
  const command = [nodePath, '-e', probeScript(), payload].map(shellQuote).join(' ');

  return {
    agentId,
    command,
    idempotencyKey: `agent-system-env-probe-${nonce}`,
    nonce,
    sessionKey: `agent:${agentId}:${probeSessionPrefix}${nonce}`,
    variables: normalizedVariables,
  };
}

export function parseExecEnvironmentProbeResult(
  response: unknown,
  probe: ExecEnvironmentProbe,
): ObservedExecEnvironmentVariable[] {
  const serialized = JSON.stringify(response) ?? '';
  const markerIndex = serialized.indexOf(probeResultMarker);
  if (markerIndex < 0) throw new Error('Gateway exec probe returned no result marker.');
  const encodedStart = markerIndex + probeResultMarker.length;
  const encoded = /^[A-Za-z0-9_-]+/.exec(serialized.slice(encodedStart))?.[0];
  if (!encoded) throw new Error('Gateway exec probe returned an invalid result marker.');

  let accepted: unknown;
  try {
    accepted = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Gateway exec probe returned an invalid result payload.');
  }
  if (!Array.isArray(accepted) || accepted.some((name) => typeof name !== 'string')) {
    throw new Error('Gateway exec probe returned an invalid accepted-variable list.');
  }
  const knownNames = new Set(probe.variables.map(({ name }) => name));
  if (accepted.some((name) => !knownNames.has(name))) {
    throw new Error('Gateway exec probe returned an unexpected environment variable name.');
  }
  const acceptedNames = new Set(accepted);
  return probe.variables.map((variable) => ({
    ...variable,
    observedExecDelivery: acceptedNames.has(variable.name) ? 'accepted' : 'filtered',
  }));
}

export function buildEnableGatewayExecCommand(currentAllow: readonly string[] = []): string {
  const nextAllow = [...new Set([...currentAllow, 'exec'])].toSorted();
  const value = JSON.stringify(nextAllow);
  return `openclaw config set gateway.tools.allow ${shellQuote(value)} --strict-json`;
}
