import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as ts from 'typescript';

const sourceRoots = [
  'agent',
  'api',
  'channels',
  'cli',
  'core',
  'credentials',
  'environment',
  'manifest',
  'paths',
  'scripts',
  'tools',
  'utils',
];
const supportedPluginSdkSubpaths = new Set([
  'agent-scope-runtime',
  'channel-core',
  'channel-inbound',
  'channel-outbound',
  'cli-argv',
  'command-auth',
  'config-contracts',
  'error-runtime',
  'gateway-runtime',
  'logging-core',
  'plugin-entry',
  'plugin-runtime',
  'reply-payload',
  'routing',
  'run-command',
  'runtime',
  'runtime-config-snapshot',
  'session-store-runtime',
  'status-helpers',
]);
const deprecatedPluginSdkSubpaths = new Set([
  'agent-runtime',
  'channel-lifecycle',
  'config-runtime',
  'infra-runtime',
]);
const privatePluginSdkSubpaths = new Set(['file-lock', 'keyed-async-queue', 'types']);
const protectedRuntimeMembers = [
  'runtime.gateway.request',
  'runtime.state.openChannelIngressQueue',
  'runtime.state.openKeyedStore',
  'runtime.state.openSyncKeyedStore',
] as const;

interface OpenClawImportFailure {
  category: 'deprecated' | 'private' | 'unsupported';
  specifier: string;
}

async function typescriptFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) return typescriptFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

async function markdownFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = join(path, entry.name);
      if (entry.isDirectory()) return markdownFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : [];
    }),
  );
  return nested.flat();
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

function openClawImportFailures(source: string, file: string): OpenClawImportFailure[] {
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

describe('openclaw api policy', () => {
  it('should detect deprecated, private, unknown, dynamic, and re-exported imports', () => {
    const source = [
      "import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-runtime';",
      "export { acquireFileLock } from 'openclaw/plugin-sdk/file-lock';",
      "export * from 'openclaw/plugin-sdk/config-types';",
      "const runtime = import('openclaw/plugin-sdk/agent-runtime');",
      "type Runtime = import('openclaw/plugin-sdk/types').PluginRuntime;",
      "import { redactSensitiveText } from 'openclaw/plugin-sdk/security-runtime';",
    ].join('\n');

    assert.deepEqual(openClawImportFailures(source, 'fixture.ts'), [
      { category: 'deprecated', specifier: 'openclaw/plugin-sdk/config-runtime' },
      { category: 'private', specifier: 'openclaw/plugin-sdk/file-lock' },
      { category: 'unsupported', specifier: 'openclaw/plugin-sdk/config-types' },
      { category: 'deprecated', specifier: 'openclaw/plugin-sdk/agent-runtime' },
      { category: 'private', specifier: 'openclaw/plugin-sdk/types' },
      { category: 'unsupported', specifier: 'openclaw/plugin-sdk/security-runtime' },
    ]);
  });

  it('should accept reviewed focused public imports', () => {
    const source = [
      "import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';",
      "import { getGlobalHookRunner } from 'openclaw/plugin-sdk/plugin-runtime';",
      "import { callGatewayFromCli } from 'openclaw/plugin-sdk/gateway-runtime';",
      "import { createAccountStatusSink } from 'openclaw/plugin-sdk/channel-outbound';",
      "import { redactSensitiveText } from 'openclaw/plugin-sdk/logging-core';",
    ].join('\n');

    assert.deepEqual(openClawImportFailures(source, 'fixture.ts'), []);
  });

  it('should keep runtime code on the reviewed public plugin sdk inventory', async () => {
    const files = [
      'index.ts',
      ...(await Promise.all(sourceRoots.map((path) => typescriptFiles(path)))).flat(),
    ];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      assert.deepEqual(
        openClawImportFailures(source, file),
        [],
        `${file} must use only the reviewed OpenClaw 2026.9.3 plugin SDK inventory`,
      );
      for (const member of protectedRuntimeMembers) {
        assert.equal(
          source.includes(member),
          false,
          `${file} must not call the protected ${member} surface`,
        );
      }
    }
  });

  it('should keep installed examples on canonical keyed agent configuration', async () => {
    for (const file of await markdownFiles('examples')) {
      const source = await readFile(file, 'utf8');
      assert.equal(
        source.includes('agents.list'),
        false,
        `${file} must use the OpenClaw 2026.9.2 agents.entries configuration`,
      );
    }
  });
});
