import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, link, lstat, open, rename, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import ensurePrivateStateDirectories from '../core/ensure-private-state-directories.ts';
import {
  AgentSystemLifecycleError,
  type AgentSystemLifecycleContext,
  type AgentSystemLifecycleContribution,
  type AgentSystemLifecycleExecutionContext,
} from '../core/lifecycle-registry.ts';
import writeAtomic from '../paths/write-atomic.ts';
import nodeErrorCode from '../utils/node-error-code.ts';
import { opServiceAccountTokenName, type AgentEnvironmentResolution } from './resolve.ts';

const environmentExportComponent = 'environment-export';

interface EnvironmentExportTarget {
  root: string;
  owner: readonly string[];
}

interface EnvironmentExportDependencies {
  target(context: AgentSystemLifecycleContext): EnvironmentExportTarget;
  resolve(context: AgentSystemLifecycleExecutionContext): Promise<AgentEnvironmentResolution>;
}

interface Destination {
  path: string;
  defaultPath: boolean;
  marker: string;
  selection: string;
}

function failure(code: string, message: string) {
  return new AgentSystemLifecycleError(environmentExportComponent, code, message);
}

function describeDestination(
  context: AgentSystemLifecycleContext,
  target: EnvironmentExportTarget,
): Destination | undefined {
  const settings = context.manifest.environment?.export;
  if (!settings) return;
  const owner = createHash('sha256').update(JSON.stringify(target.owner)).digest('hex');
  const path =
    settings.path === undefined
      ? join(target.root, 'environment-exports', owner + '.sh')
      : resolve(context.workspaceDir, settings.path);
  return {
    path,
    defaultPath: settings.path === undefined,
    marker: '# agent-system environment export v1 ' + owner + '\n',
    selection: '# variables: ' + settings.variables.toSorted().join(' ') + '\n',
  };
}

async function inspectParent({ path, defaultPath }: Destination, create = false) {
  const parent = dirname(path);
  if (create && defaultPath) {
    await ensurePrivateStateDirectories({
      currentUid: process.getuid?.(),
      directories: [parent],
      label: 'Environment export',
    });
  }
  const stats = await lstat(parent).catch((error: unknown) => {
    if (defaultPath && nodeErrorCode(error) === 'ENOENT') return;
    throw error;
  });
  if (!stats) return;
  const disallowedMode = defaultPath ? 0o077 : 0o022;
  const uid = process.getuid?.();
  if (
    !stats.isDirectory() ||
    stats.mode & disallowedMode ||
    (uid !== undefined && stats.uid !== uid)
  )
    throw failure(
      'environment-export-parent-unsafe',
      'Choose an owner-controlled directory for the environment export.',
    );
  return stats;
}

async function startsWith(file: FileHandle, source: string) {
  const expected = Buffer.from(source);
  const actual = Buffer.alloc(expected.length);
  const { bytesRead } = await file.read(actual, 0, actual.length, 0);
  return bytesRead === expected.length && expected.equals(actual);
}

async function inspectFile(destination: Destination, expected?: string) {
  const { path, marker, selection } = destination;
  const stats = await lstat(path).catch((error: unknown) => {
    if (nodeErrorCode(error) === 'ENOENT') return;
    throw error;
  });
  if (!stats) return;
  const uid = process.getuid?.();
  if (!stats.isFile() || stats.nlink !== 1 || (uid !== undefined && stats.uid !== uid))
    throw failure(
      'environment-export-target-unsafe',
      'The environment export path is occupied by an unsafe file.',
    );

  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (opened.dev !== stats.dev || opened.ino !== stats.ino || opened.nlink !== 1)
      throw failure(
        'environment-export-target-changed',
        'The environment export path changed during inspection. Retry Install.',
      );
    if (!(await startsWith(file, marker)))
      throw failure(
        'environment-export-target-foreign',
        'The environment export path is occupied by a file owned by another configuration.',
      );

    return {
      stats: opened,
      privateMode: (opened.mode & 0o7777) === 0o600,
      selectionMatches: await startsWith(file, marker + selection),
      contentMatches:
        expected !== undefined &&
        opened.size === Buffer.byteLength(expected) &&
        (await startsWith(file, expected)),
    };
  } finally {
    await file.close();
  }
}

function shellExports(names: string[], values: Record<string, string>) {
  return names
    .map((name) => {
      if (name === opServiceAccountTokenName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw failure(
          'environment-export-name-invalid',
          'The environment export contains an invalid or reserved variable name.',
        );
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      if (value === undefined || value.includes('\0'))
        throw failure(
          'environment-export-value-unavailable',
          'The selected environment variable ' + name + ' is missing or cannot be exported.',
        );
      const quoted = "'" + value.replaceAll("'", "'\\''") + "'";
      // Clear an existing integer or array attribute before assigning literal data.
      return (
        'builtin unset -v ' + name + ' && builtin export ' + name + '=' + quoted + ' || return 1\n'
      );
    })
    .join('');
}

/** Reconcile a private shell snapshot only from an explicit Install. */
export default function createEnvironmentExportLifecycle(
  dependencies: EnvironmentExportDependencies,
) {
  return {
    id: environmentExportComponent,
    isConfigured: (manifest) => manifest.environment?.export !== undefined,
    async inspect(context) {
      const destination = describeDestination(context, dependencies.target(context));
      if (!destination) return [];
      const { path } = destination;
      try {
        const saved = (await inspectParent(destination)) && (await inspectFile(destination));
        if (saved?.privateMode && saved.selectionMatches)
          return [{ code: 'environment-export-ready', message: path, status: 'healthy' }];
        return [
          {
            code: saved ? 'environment-export-drift' : 'environment-export-missing',
            message: path,
            remediation: 'Run Install to write the selected environment export.',
            status: 'drift',
          },
        ];
      } catch (error) {
        return [
          {
            code:
              error instanceof AgentSystemLifecycleError
                ? error.code
                : 'environment-export-inspection-failed',
            message:
              error instanceof AgentSystemLifecycleError
                ? error.rawMessage
                : 'The environment export path could not be inspected.',
            remediation: 'Check the configured output path and its permissions.',
            status: 'blocked',
          },
        ];
      }
    },
    async reconcile(context: AgentSystemLifecycleExecutionContext) {
      const settings = context.manifest.environment?.export;
      const destination = settings && describeDestination(context, dependencies.target(context));
      if (!settings || !destination) return { outcomes: [] };
      const { path, marker, selection } = destination;
      try {
        await inspectParent(destination);
        const resolution = settings.variables.length
          ? await dependencies.resolve(context)
          : undefined;
        if (resolution?.status === 'invalid') {
          const diagnostic = resolution.diagnostics.find(({ severity }) => severity === 'error');
          throw failure(
            diagnostic?.code ?? 'environment-export-resolution-failed',
            'The selected environment could not be resolved for export. Check the declared environment sources.',
          );
        }
        const source =
          marker +
          selection +
          shellExports(settings.variables.toSorted(), resolution?.environment.values ?? {});
        context.signal?.throwIfAborted();
        await context.assertCurrent?.();
        const parent = await inspectParent(destination, true);
        if (!parent) throw new Error('Missing export directory.');
        const saved = await inspectFile(destination, source);
        if (saved?.privateMode && saved.contentMatches)
          return {
            outcomes: [
              { code: 'environment-export-unchanged', message: path, status: 'unchanged' },
            ],
          };

        await writeAtomic(path, source, 0o600, async (temporaryPath) => {
          context.signal?.throwIfAborted();
          await context.assertCurrent?.();
          const currentParent = await inspectParent(destination);
          if (currentParent?.dev !== parent.dev || currentParent.ino !== parent.ino)
            throw failure(
              'environment-export-target-changed',
              'The environment export directory changed. Retry Install.',
            );
          await chmod(temporaryPath, 0o600);
          if (!saved) {
            await link(temporaryPath, path);
            return;
          }
          const current = await lstat(path);
          if (
            current.dev !== saved.stats.dev ||
            current.ino !== saved.stats.ino ||
            current.nlink !== 1
          )
            throw failure(
              'environment-export-target-changed',
              'The environment export path changed. Retry Install.',
            );
          await rename(temporaryPath, path);
        });
        return {
          outcomes: [
            {
              code: saved ? 'environment-export-updated' : 'environment-export-created',
              message: path,
              status: saved ? 'updated' : 'created',
            },
          ],
        };
      } catch (error) {
        context.signal?.throwIfAborted();
        if (error instanceof AgentSystemLifecycleError) throw error;
        await context.assertCurrent?.();
        throw failure(
          'environment-export-write-failed',
          'The environment export could not be written. Check the configured output path and its permissions.',
        );
      }
    },
  } satisfies AgentSystemLifecycleContribution;
}
