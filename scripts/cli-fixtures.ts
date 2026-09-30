import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { configure, verify } = createRequire(import.meta.url)('@approval-tests/approvals') as {
  configure: (options: object) => void;
  verify: (directory: string, name: string, contents: string, options: object) => void;
};

const repository = 'tanaabased/big-test-bucket';
const fixturesDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const timeoutMs = 60_000;

export type CliFixtureCaseId = 'pr-author' | 'pr-reviews';
export type CliFixtureAction = 'check' | 'record' | 'accept';

export interface CliCapture {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
}

export type CliExecutor = (
  executable: string,
  argv: readonly string[],
  stdin?: string,
) => CliCapture;

export interface CliFixtureOptions {
  action: CliFixtureAction;
  caseId: CliFixtureCaseId;
  pr?: number;
  author?: string;
  reviewer?: string;
  fixtureDir?: string;
  execute?: CliExecutor;
  now?: () => string;
  verifyApproval?: typeof verify;
}

interface ApprovedCapture {
  argv: string[];
  caseId: CliFixtureCaseId;
  executable: 'gh';
  exitCode: 0;
  schemaVersion: 1;
  stderr: '';
  stdin: null;
  stdout: string;
}

const approvalOptions = {
  appendEOL: false,
  errorOnStaleApprovedFiles: false,
  failOnLineEndingDifferences: true,
  forceApproveAll: false,
  reporters: [{ name: 'silent', canReportOn: () => true, report: () => undefined }],
};

function defaultExecutor(executable: string, argv: readonly string[], stdin?: string): CliCapture {
  const result = spawnSync(executable, [...argv], {
    encoding: 'utf8',
    input: stdin,
    maxBuffer: 2 * 1024 * 1024,
    timeout: timeoutMs,
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    exitCode: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
    timedOut: code === 'ETIMEDOUT',
    truncated: code === 'ENOBUFS',
  };
}

function successful(result: CliCapture, operation: string): string {
  if (
    result.exitCode !== 0 ||
    result.timedOut ||
    result.truncated ||
    !result.stdout.trim() ||
    result.stderr.trim()
  ) {
    throw new Error(`${operation} did not produce a complete successful response.`);
  }
  return result.stdout;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} has an invalid shape.`);
  }
  return value as Record<string, unknown>;
}

function json(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

function safeLogin(value: unknown, label: string): string {
  const login = nonemptyString(value, label);
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(login)) {
    throw new Error(`${label} is invalid.`);
  }
  return login;
}

/** use the same argv shape as the delivery service; only repository and pr are variable. */
export function githubCliFixtureArgv(
  caseId: CliFixtureCaseId,
  selectedRepository: string,
  pr: number,
  capturePages = false,
): string[] {
  if (caseId === 'pr-author') {
    return ['api', `repos/${selectedRepository}/pulls/${pr}`, '--jq', '{nodeId:.user.node_id}'];
  }
  return [
    'api',
    `repos/${selectedRepository}/pulls/${pr}/reviews${capturePages ? '?per_page=1' : ''}`,
    '--paginate',
    '--slurp',
  ];
}

function stableArgv(caseId: CliFixtureCaseId): string[] {
  return githubCliFixtureArgv(caseId, '{repository}', 1, true).map((part) =>
    part.replace('repos/{repository}/pulls/1', 'repos/{repository}/pulls/{pr}'),
  );
}

function normalizedOutput(
  caseId: CliFixtureCaseId,
  stdout: string,
  reviewer: string | undefined,
): string {
  const newline = stdout.endsWith('\n') ? '\n' : '';
  const value = json(stdout, caseId);
  if (caseId === 'pr-author') {
    nonemptyString(object(value, caseId).nodeId, 'pull request author node id');
    return `${JSON.stringify({ nodeId: 'U_agent' })}${newline}`;
  }
  if (!reviewer) throw new Error('The review case requires a declared reviewer.');
  if (!Array.isArray(value) || value.length < 2 || !value.every(Array.isArray)) {
    throw new Error('The review capture must contain at least two actual pages.');
  }
  let pendingReviewerPage: number | undefined;
  let completedLaterPage = false;
  const pages = value.map((page: unknown[], pageIndex) =>
    page.map((entry) => {
      const review = object(entry, 'pull request review');
      const state = nonemptyString(review.state, 'review state');
      const login = safeLogin(object(review.user, 'review user').login, 'reviewer login');
      const declaredReviewer = login.toLowerCase() === reviewer.toLowerCase();
      if (declaredReviewer) {
        if (state === 'PENDING') pendingReviewerPage ??= pageIndex;
        else if (pendingReviewerPage !== undefined && pageIndex > pendingReviewerPage)
          completedLaterPage = true;
      }
      return {
        state,
        user: {
          login: declaredReviewer ? 'reviewer' : 'other-reviewer',
        },
      };
    }),
  );
  if (!completedLaterPage) {
    throw new Error(
      'The review capture needs a pending review followed by a completed review from the declared reviewer on a later page.',
    );
  }
  return `${JSON.stringify(pages)}${newline}`;
}

function capturePaths(directory: string, caseId: CliFixtureCaseId) {
  return {
    approved: join(directory, `${caseId}.approved.txt`),
    approvedMeta: join(directory, `${caseId}.meta.json`),
    received: join(directory, `${caseId}.received.txt`),
    receivedMeta: join(directory, `${caseId}.received.meta.json`),
  };
}

function digest(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

export function loadApprovedCliFixture(caseId: CliFixtureCaseId): ApprovedCapture {
  const path = capturePaths(fixturesDirectory, caseId).approved;
  if (!existsSync(path)) throw new Error(`Missing approved CLI fixture: ${caseId}.`);
  const parsed = object(json(readFileSync(path, 'utf8'), caseId), caseId);
  if (
    parsed.schemaVersion !== 1 ||
    parsed.caseId !== caseId ||
    parsed.executable !== 'gh' ||
    parsed.exitCode !== 0 ||
    parsed.stderr !== '' ||
    parsed.stdin !== null ||
    typeof parsed.stdout !== 'string' ||
    !parsed.stdout.trim() ||
    JSON.stringify(parsed.argv) !== JSON.stringify(stableArgv(caseId))
  ) {
    throw new Error(`The approved CLI fixture ${caseId} is invalid.`);
  }
  return parsed as unknown as ApprovedCapture;
}

export function runCliFixture(options: CliFixtureOptions): string {
  const directory = options.fixtureDir ?? fixturesDirectory;
  const paths = capturePaths(directory, options.caseId);
  if (options.action === 'accept') {
    if (!existsSync(paths.received) || !existsSync(paths.receivedMeta)) {
      throw new Error(
        `The ${options.caseId} candidate and provenance are required for acceptance.`,
      );
    }
    const contents = readFileSync(paths.received, 'utf8');
    const candidate = object(json(contents, options.caseId), options.caseId);
    const metadata = object(
      json(readFileSync(paths.receivedMeta, 'utf8'), 'capture provenance'),
      'capture provenance',
    );
    if (
      candidate.schemaVersion !== 1 ||
      candidate.caseId !== options.caseId ||
      candidate.executable !== 'gh' ||
      candidate.exitCode !== 0 ||
      candidate.stderr !== '' ||
      candidate.stdin !== null ||
      typeof candidate.stdout !== 'string' ||
      !candidate.stdout.trim() ||
      JSON.stringify(candidate.argv) !== JSON.stringify(stableArgv(options.caseId)) ||
      metadata.caseId !== options.caseId ||
      metadata.repository !== repository ||
      metadata.captureDigest !== digest(contents)
    ) {
      throw new Error(`The ${options.caseId} candidate is invalid.`);
    }
    copyFileSync(paths.received, paths.approved);
    copyFileSync(paths.receivedMeta, paths.approvedMeta);
    return `Accepted ${options.caseId}.`;
  }

  const pr = options.pr;
  if (!Number.isSafeInteger(pr) || !pr || pr < 1) throw new Error('A positive --pr is required.');
  const author = safeLogin(options.author, 'declared PR author');
  const reviewer =
    options.caseId === 'pr-reviews' ? safeLogin(options.reviewer, 'declared reviewer') : undefined;
  const execute = options.execute ?? defaultExecutor;
  const identity = object(
    json(
      successful(
        execute('gh', ['api', 'user', '--jq', '{login,nodeId:.node_id}']),
        'GitHub identity check',
      ),
      'GitHub identity',
    ),
    'GitHub identity',
  );
  const login = safeLogin(identity.login, 'effective GitHub login');
  nonemptyString(identity.nodeId, 'effective GitHub node id');
  const access = object(
    json(
      successful(
        execute('gh', ['api', `repos/${repository}`, '--jq', '{fullName:.full_name,permissions}']),
        'repository access check',
      ),
      'repository access',
    ),
    'repository access',
  );
  if (
    access.fullName !== repository ||
    !object(access.permissions, 'repository permissions').pull
  ) {
    throw new Error('The effective GitHub account lacks access to the fixture repository.');
  }
  const source = object(
    json(
      successful(
        execute('gh', ['api', `repos/${repository}/pulls/${pr}`, '--jq', '{author:.user.login}']),
        'PR source check',
      ),
      'PR source',
    ),
    'PR source',
  );
  if (safeLogin(source.author, 'PR author').toLowerCase() !== author.toLowerCase()) {
    throw new Error('The declared PR author does not match the controlled source.');
  }
  const version = successful(execute('gh', ['--version']), 'GitHub CLI version check').split(
    '\n',
  )[0];
  const argv = githubCliFixtureArgv(options.caseId, repository, pr, true);
  const stdout = normalizedOutput(
    options.caseId,
    successful(execute('gh', argv), options.caseId),
    reviewer,
  );
  const capture: ApprovedCapture = {
    argv: stableArgv(options.caseId),
    caseId: options.caseId,
    executable: 'gh',
    exitCode: 0,
    schemaVersion: 1,
    stderr: '',
    stdin: null,
    stdout,
  };
  const serialized = `${JSON.stringify(capture, null, 2)}\n`;
  if (options.action === 'record') {
    const metadata = {
      author,
      capturedAt: (options.now ?? (() => new Date().toISOString()))(),
      captureDigest: digest(serialized),
      caseId: options.caseId,
      cliVersion: version,
      effectiveLogin: login,
      pr,
      repository,
      requiredActors: reviewer ? { author, reviewer } : { author },
    };
    writeFileSync(paths.received, serialized);
    writeFileSync(paths.receivedMeta, `${JSON.stringify(metadata, null, 2)}\n`);
    return `Recorded ${options.caseId} candidate for review.`;
  }
  if (!existsSync(paths.approved))
    throw new Error(`Missing approved CLI fixture: ${options.caseId}.`);
  configure(approvalOptions);
  (options.verifyApproval ?? verify)(directory, options.caseId, serialized, approvalOptions);
  return `Checked ${options.caseId}.`;
}

function commandLine(argv: string[]): CliFixtureOptions {
  const [action, ...rest] = argv;
  if (action !== 'check' && action !== 'record' && action !== 'accept') {
    throw new Error('Use check, record, or accept.');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || !value || values.has(key))
      throw new Error('Invalid fixture options.');
    values.set(key, value);
  }
  for (const key of values.keys()) {
    if (!['--case', '--pr', '--author', '--reviewer'].includes(key))
      throw new Error('Unknown fixture option.');
  }
  const caseId = values.get('--case');
  if (caseId !== 'pr-author' && caseId !== 'pr-reviews') throw new Error('Select a named --case.');
  const pr = values.get('--pr');
  return {
    action,
    caseId,
    ...(pr === undefined ? {} : { pr: Number(pr) }),
    ...(values.has('--author') ? { author: values.get('--author') } : {}),
    ...(values.has('--reviewer') ? { reviewer: values.get('--reviewer') } : {}),
  };
}

if (import.meta.main) {
  try {
    process.stdout.write(`${runCliFixture(commandLine(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'CLI fixture command failed.'}\n`,
    );
    process.exitCode = 1;
  }
}
