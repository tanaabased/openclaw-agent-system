import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ClawHubValidation {
  status?: string;
  summary?: {
    breakageCount?: number;
    warningCount?: number;
  };
}

interface CodexPluginManifest {
  description?: string;
  name?: string;
  skills?: string;
  version?: string;
}

interface PackageMetadata {
  dependencies?: Record<string, string>;
  description?: string;
  name?: string;
  optionalDependencies?: Record<string, string>;
  version?: string;
  openclaw?: {
    runtimeExtensions?: string[];
  };
}

interface PackResult {
  filename?: string;
  files?: Array<{ path: string }>;
}

interface PluginManifest {
  id?: string;
  secretProviderIntegrations?: Record<string, Record<string, unknown>>;
  skills?: string[];
  version?: string;
}

interface RunOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
}

interface RunResult {
  output: string;
}

let attemptedChecks = 0;
let passedChecks = 0;

async function check<T>(label: string, action: () => T | Promise<T>): Promise<T> {
  const checkNumber = ++attemptedChecks;
  try {
    const result = await action();
    passedChecks += 1;
    process.stdout.write(`ok ${checkNumber} - ${label}\n`);
    return result;
  } catch (error) {
    process.stderr.write(`not ok ${checkNumber} - ${label}\n`);
    throw error;
  }
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const child = spawn(command, args, {
    env: options.env ?? process.env,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout!.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (output += chunk.toString()));
  if (options.input !== undefined) child.stdin!.end(options.input);
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode) => resolveExit(exitCode ?? 1));
  });

  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${code})\n${output}`);
  }

  return { output };
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'openclaw-agent-system-package-'));
const suppliedArchivePath = process.env.AGENT_SYSTEM_PACKAGE?.trim();
const environment = {
  ...process.env,
  npm_config_cache: join(temporaryRoot, 'npm-cache'),
};

try {
  await check('build the plugin runtime', () => run('bun', ['run', 'build']));
  await check('validate plugin metadata', () => run('bun', ['run', 'plugin:check']));

  const { archivePath, packageResult } = await check(
    suppliedArchivePath
      ? 'inspect the supplied npm package archive'
      : 'create the npm package archive',
    async () => {
      if (suppliedArchivePath) {
        const archivePath = resolve(suppliedArchivePath);
        await access(archivePath);
        assert.match(archivePath, /\.tgz$/);
        const inspected = await run(
          'npm',
          ['pack', archivePath, '--dry-run', '--ignore-scripts', '--json', '--offline'],
          { env: environment },
        );
        const result = (JSON.parse(inspected.output) as PackResult[])[0];
        if (!result?.filename) throw new Error('npm pack did not inspect the supplied archive');
        return { archivePath, packageResult: result };
      }

      const packed = await run(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--silent', '--pack-destination', temporaryRoot],
        { env: environment },
      );
      const result = (JSON.parse(packed.output) as PackResult[])[0];
      if (!result?.filename) throw new Error('npm pack did not report an archive');
      assert.match(result.filename, /\.tgz$/);
      const path = join(temporaryRoot, result.filename);
      await access(path);
      return { archivePath: path, packageResult: result };
    },
  );

  const packedPaths = new Set(packageResult.files?.map(({ path }) => path));
  const packageSourcePaths = await check('inventory working-tree package sources', async () => {
    const sourceDirectories = [
      'agent',
      'api',
      'bin',
      'channels',
      'cli',
      'core',
      'credentials',
      'environment',
      'hooks',
      'manifest',
      'paths',
      'skills',
      'tools',
      'utils',
    ];
    const [candidates, deleted] = await Promise.all([
      run('git', [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        ...sourceDirectories,
      ]),
      run('git', ['ls-files', '--deleted', '-z', '--', ...sourceDirectories]),
    ]);
    const deletedPaths = new Set(deleted.output.split('\0').filter(Boolean));
    const paths = candidates.output.split('\0').filter((path) => path && !deletedPaths.has(path));
    assert.notEqual(paths.length, 0, 'package source inventory must not be empty');
    return paths;
  });
  const requiredArtifactPaths = [
    '.codex-plugin/plugin.json',
    'package.json',
    'openclaw.plugin.json',
    'dist/index.js',
    'dist/index.js.map',
    'dist/memory-secret-provider-entry.js',
    'dist/memory-secret-provider-entry.js.map',
    'dist/codex/codex-runtime.js',
    'dist/codex/codex-runtime.js.map',
    'hooks/hooks.json',
    'index.ts',
    'bin/agent-system-ssh',
    'bin/agent-system-ssh-keygen',
    'bin/agent-system-ssh-signing-key',
    'bin/agent-system-tool',
    'bin/git',
    'bin/gh',
    'channels/github/DESIGN.md',
    'channels/github/PRESENTATION.md',
    'skills/git-cli/SKILL.md',
    'skills/git-cli/agents/openai.yaml',
    'skills/github-cli/SKILL.md',
    'skills/github-cli/agents/openai.yaml',
    'skills/github-update/SKILL.md',
    'skills/github-update/agents/openai.yaml',
    'assets/icon.png',
    'assets/git-icon-small.svg',
    'assets/git-icon-large.svg',
    'assets/github-icon-small.svg',
    'assets/github-icon-large.svg',
    'README.md',
    'API.md',
    'ADVANCED.md',
    'DEVELOPMENT.md',
    'CHANGELOG.md',
    'LICENSE',
  ];
  await check('include required package files', () => {
    for (const path of [...requiredArtifactPaths, ...packageSourcePaths]) {
      assert.equal(packedPaths.has(path), true, `packed plugin is missing ${path}`);
    }
  });
  await check('exclude repository-only files', () => {
    for (const path of [
      'AGENTS.md',
      'examples/install/README.md',
      'scenarios/issue-guided-assignment/expected-evidence.json',
      'scenarios/issue-guided-assignment/model-fixture.ts',
      'scenarios/issue-work-assignment/expected-evidence.json',
      'scenarios/issue-work-assignment/model-fixture.ts',
      'scenarios/issue-work-comment/expected-evidence.json',
      'scenarios/issue-work-comment/model-fixture.ts',
      'scenarios/issue-work-implementation/expected-evidence.json',
      'scenarios/issue-work-implementation/model-fixture.ts',
      'scenarios/issue-work-pr-lifecycle/expected-evidence.json',
      'scenarios/issue-work-pr-lifecycle/model-fixture.ts',
      'scenarios/issue-work-retirement/expected-evidence.json',
      'scenarios/issue-work-retirement/model-fixture.ts',
      'scripts/github-notification-model-issue-work-scenario.ts',
      'scripts/openclaw-aimock',
      'scripts/aimock-server.ts',
      'scripts/openclaw-notification-setup',
      'test/encode.spec.ts',
    ]) {
      assert.equal(packedPaths.has(path), false, `packed plugin must exclude ${path}`);
    }
  });

  const packageRoot = await check('extract the npm package archive', async () => {
    const unpackedRoot = join(temporaryRoot, 'unpacked');
    await mkdir(unpackedRoot);
    await run('tar', ['-xzf', archivePath, '-C', unpackedRoot]);
    return join(unpackedRoot, 'package');
  });

  await check('match package and plugin metadata', async () => {
    const [packageContents, manifestContents, codexManifestContents] = await Promise.all([
      readFile(join(packageRoot, 'package.json'), 'utf8'),
      readFile(join(packageRoot, 'openclaw.plugin.json'), 'utf8'),
      readFile(join(packageRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
    ]);
    const packageMetadata = JSON.parse(packageContents) as PackageMetadata;
    const manifest = JSON.parse(manifestContents) as PluginManifest;
    const codexManifest = JSON.parse(codexManifestContents) as CodexPluginManifest;
    assert.equal(packageMetadata.name, '@tanaab/openclaw-agent-system');
    assert.equal(packageMetadata.dependencies?.['@1password/sdk'], '0.5.0');
    assert.equal(packageMetadata.dependencies?.['@clack/prompts'], '1.6.0');
    assert.equal(packageMetadata.optionalDependencies?.['@napi-rs/keyring'], '1.3.0');
    assert.equal(packageMetadata.version, manifest.version);
    assert.equal(packageMetadata.version, codexManifest.version);
    assert.equal(manifest.id, 'agent-system');
    assert.deepEqual(manifest.skills, ['./skills']);
    assert.equal(codexManifest.name, 'agent-system');
    assert.equal(codexManifest.description, packageMetadata.description);
    assert.equal(codexManifest.skills, './skills/');
    assert.deepEqual(manifest.secretProviderIntegrations?.environment, {
      providerAlias: 'agent-system-environment',
      displayName: 'Agent System environment',
      description:
        'Resolves one manifest-authorized agent environment binding for built-in memory search.',
      source: 'exec',
      command: '${node}',
      args: ['./dist/memory-secret-provider-entry.js'],
      timeoutMs: 90_000,
      noOutputTimeoutMs: 90_000,
      maxOutputBytes: 1_048_576,
      jsonOnly: true,
      passEnv: [
        'DBUS_SESSION_BUS_ADDRESS',
        'HOME',
        'OPENAI_API_KEY',
        'OPENCLAW_CONFIG_PATH',
        'OPENCLAW_STATE_DIR',
        'XDG_CONFIG_HOME',
        'XDG_RUNTIME_DIR',
      ],
    });
    assert.deepEqual(packageMetadata.openclaw?.runtimeExtensions, ['./dist/index.js']);
  });

  await check('ship discoverable Codex skills', async () => {
    const skillsRoot = join(packageRoot, 'skills');
    const skillDirectories = (await readdir(skillsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(({ name }) => name);
    assert.notEqual(skillDirectories.length, 0, 'Codex plugin must ship at least one skill');
    for (const name of skillDirectories) {
      await access(join(skillsRoot, name, 'SKILL.md'));
      await access(join(skillsRoot, name, 'agents', 'openai.yaml'));
    }
  });

  await check('ship a valid canonical OpenClaw plugin icon', async () => {
    const icon = await readFile(join(packageRoot, 'assets', 'icon.png'));
    assert.deepEqual([...icon.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.equal(icon.subarray(12, 16).toString('ascii'), 'IHDR');
    const width = icon.readUInt32BE(16);
    const height = icon.readUInt32BE(20);
    assert.equal(width, height, 'plugin icon must be square');
    assert.ok(width >= 16, 'plugin icon must remain usable at 16 px');
  });

  await check('ship the built Agent System plugin entry', async () => {
    const [localEntry, packedEntry] = await Promise.all([
      readFile(join(process.cwd(), 'dist', 'index.js')),
      readFile(join(packageRoot, 'dist', 'index.js')),
    ]);
    assert.deepEqual(packedEntry, localEntry);

    const entryUrl = pathToFileURL(join(process.cwd(), 'dist', 'index.js'));
    const builtModule = (await import(entryUrl.href)) as {
      default?: { id?: string; name?: string; register?: unknown };
    };
    assert.equal(builtModule.default?.id, 'agent-system');
    assert.equal(builtModule.default?.name, 'Agent System');
    assert.equal(typeof builtModule.default?.register, 'function');
  });

  await check('ship the built Agent System memory secret provider entry', async () => {
    const [localEntry, packedEntry] = await Promise.all([
      readFile(join(process.cwd(), 'dist', 'memory-secret-provider-entry.js')),
      readFile(join(packageRoot, 'dist', 'memory-secret-provider-entry.js')),
    ]);
    assert.deepEqual(packedEntry, localEntry);
  });

  await check('ship an executable Codex session hook', async () => {
    const result = await run(
      process.execPath,
      [join(packageRoot, 'dist', 'codex', 'codex-runtime.js'), 'session-start'],
      {
        env: {
          ...environment,
          PLUGIN_DATA: join(temporaryRoot, 'codex-plugin-data'),
          PLUGIN_ROOT: packageRoot,
        },
        input: `${JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' })}\n`,
      },
    );
    const response = JSON.parse(result.output) as {
      hookSpecificOutput?: { additionalContext?: string; hookEventName?: string };
    };
    assert.equal(response.hookSpecificOutput?.hookEventName, 'SessionStart');
    assert.match(response.hookSpecificOutput?.additionalContext ?? '', /"status": "unbound"/u);
  });

  await check('ship an executable Agent System gh command', async () => {
    const commandPath = join(packageRoot, 'bin', 'gh');
    await access(commandPath);
    const result = await run(commandPath, ['--agent-system']);
    assert.equal(result.output, 'agent-system\n');
  });

  await check('ship an executable Agent System git command', async () => {
    const commandPath = join(packageRoot, 'bin', 'git');
    await access(commandPath);
    const result = await run(commandPath, ['--agent-system']);
    assert.equal(result.output, 'agent-system\n');
  });

  await check('ship the reusable Agent System tool launcher', async () => {
    const commandPath = join(packageRoot, 'bin', 'agent-system-tool');
    await access(commandPath);
    const result = await run(commandPath, ['git', '--agent-system']);
    assert.equal(result.output, 'agent-system\n');
  });

  await check('ship an executable Agent System ssh launcher', async () => {
    const commandPath = join(packageRoot, 'bin', 'agent-system-ssh');
    await access(commandPath);
    await run(commandPath, ['github.com'], {
      env: {
        ...environment,
        AGENT_SYSTEM_SSH_CONFIG: '/dev/null',
        AGENT_SYSTEM_SSH_EXECUTABLE: '/usr/bin/true',
      },
    });
  });

  await check('ship an executable Agent System ssh signing-key helper', async () => {
    const commandPath = join(packageRoot, 'bin', 'agent-system-ssh-signing-key');
    await access(commandPath);
    const result = await run(commandPath, [], {
      env: {
        ...environment,
        AGENT_SYSTEM_SSH_ADD_EXECUTABLE: '/bin/echo',
        AGENT_SYSTEM_SSH_SIGNING_SOCKET: '/tmp/agent-system-signing.sock',
      },
    });
    assert.equal(result.output, 'key::-L\n');
  });

  await check('ship an executable Agent System ssh-keygen helper', async () => {
    const commandPath = join(packageRoot, 'bin', 'agent-system-ssh-keygen');
    await access(commandPath);
    await run(commandPath, ['-Y', 'verify'], {
      env: {
        ...environment,
        AGENT_SYSTEM_SSH_KEYGEN_EXECUTABLE: '/usr/bin/true',
        AGENT_SYSTEM_SSH_SIGNING_SOCKET: '/tmp/agent-system-signing.sock',
      },
    });
  });

  await check('pass ClawHub package validation without warnings', async () => {
    const clawHubReports = join(temporaryRoot, 'clawhub-reports');
    const clawHubResult = await run('clawhub', [
      'package',
      'validate',
      packageRoot,
      '--out',
      clawHubReports,
    ]);
    const clawHubValidation = JSON.parse(
      await readFile(join(clawHubReports, 'plugin-inspector-report.json'), 'utf8'),
    ) as ClawHubValidation;
    const clawHubOutput = clawHubResult.output.trim();
    assert.equal(
      clawHubValidation.status,
      'pass',
      `ClawHub package validation must pass\n${clawHubOutput}`,
    );
    assert.equal(
      clawHubValidation.summary?.breakageCount,
      0,
      `ClawHub package validation must report no breakages\n${clawHubOutput}`,
    );
    assert.equal(
      clawHubValidation.summary?.warningCount,
      0,
      `ClawHub package validation must report no warnings\n${clawHubOutput}`,
    );
  });
} catch (error) {
  process.stderr.write(
    `release package checks: failed (${passedChecks}/${attemptedChecks} passed)\n`,
  );
  throw error;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

process.stdout.write(`release package checks: ok (${passedChecks} passed)\n`);
