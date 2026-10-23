import * as ts from 'typescript';

const supportedPluginSdkSubpaths = new Set([
  'agent-scope-runtime',
  'approval-runtime',
  'channel-config-schema',
  'channel-core',
  'channel-inbound',
  'channel-outbound',
  'cli-argv',
  'command-auth',
  'config-contracts',
  'device-bootstrap',
  'error-runtime',
  'gateway-runtime',
  'logging-core',
  'model-session-runtime',
  'plugin-entry',
  'plugin-runtime',
  'process-runtime',
  'reply-payload',
  'routing',
  'run-command',
  'runtime',
  'runtime-config-snapshot',
  'secret-ref-runtime',
  'session-store-runtime',
  'session-visibility',
  'setup-runtime',
  'skill-commands-runtime',
  'status-helpers',
]);
const deprecatedPluginSdkSubpaths = new Set([
  'agent-runtime',
  'channel-lifecycle',
  'config-runtime',
  'infra-runtime',
]);
const privatePluginSdkSubpaths = new Set(['file-lock', 'keyed-async-queue', 'types']);
interface OpenClawImportFailure {
  category: 'deprecated' | 'private' | 'unsupported';
  specifier: string;
}

function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function moduleSpecifiers(source: string, file: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = stringLiteralValue(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = stringLiteralValue(node.arguments[0]);
      if (specifier) specifiers.push(specifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = stringLiteralValue(node.argument.literal);
      if (specifier) specifiers.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

export default function openClawImportFailures(
  source: string,
  file: string,
): OpenClawImportFailure[] {
  const failures: OpenClawImportFailure[] = [];
  for (const specifier of moduleSpecifiers(source, file)) {
    if (!specifier.startsWith('openclaw')) continue;
    const prefix = 'openclaw/plugin-sdk/';
    if (!specifier.startsWith(prefix)) {
      failures.push({ category: 'unsupported', specifier });
      continue;
    }
    const subpath = specifier.slice(prefix.length);
    if (deprecatedPluginSdkSubpaths.has(subpath)) {
      failures.push({ category: 'deprecated', specifier });
    } else if (privatePluginSdkSubpaths.has(subpath)) {
      failures.push({ category: 'private', specifier });
    } else if (!supportedPluginSdkSubpaths.has(subpath)) {
      failures.push({ category: 'unsupported', specifier });
    }
  }
  return failures;
}
