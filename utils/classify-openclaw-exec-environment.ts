export type StaticExecDelivery = 'documented-filtered' | 'exec-candidate';

const filteredNames = new Set([
  'ALL_PROXY',
  'BASH_ENV',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'NODE_OPTIONS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'NO_PROXY',
  'OPENCLAW_CLI',
  'PATH',
  'SHELL',
  'SSH_AUTH_SOCK',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'ZDOTDIR',
]);

const filteredPrefixes = ['BASH_FUNC_', 'DYLD_', 'GIT_CONFIG_', 'LD_'];

/** Classify documented high-value restrictions without copying OpenClaw's private filter. */
export default function classifyOpenClawExecEnvironment(name: string): StaticExecDelivery {
  const normalized = name.toUpperCase();
  if (filteredNames.has(normalized)) return 'documented-filtered';
  if (filteredPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return 'documented-filtered';
  }
  return 'exec-candidate';
}
