import { basename, dirname, isAbsolute, resolve } from 'node:path';

export interface AgentOperatorInvocation {
  recommendedTool?: string;
  surface: 'credentials' | 'shim' | 'tool';
  targetAgentDynamic: boolean;
  targetAgentId?: string;
}

export interface AgentCommandInspection {
  cwd?: string;
  operatorInvocations: AgentOperatorInvocation[];
  status: 'command' | 'irrelevant';
}

export interface InspectAgentCommandOptions {
  managedExecutableDirectories?: readonly string[];
}

interface ShellToken {
  kind: 'control' | 'word';
  value: string;
}

const commandToolNames = new Set(['exec', 'exec_command']);
const shellControls = new Set(['&', '(', ')', ';', '|']);

function tokenizeShellCommand(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = '';
  let quote: "'" | '"' | undefined;

  const finishWord = () => {
    if (!word) return;
    tokens.push({ kind: 'word', value: word });
    word = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === '\\' && quote === '"' && index + 1 < command.length) {
        index += 1;
        word += command[index] ?? '';
      } else {
        word += character;
      }
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === '\\' && index + 1 < command.length) {
      index += 1;
      word += command[index] ?? '';
      continue;
    }
    if (/\s/u.test(character)) {
      finishWord();
      if (character === '\n') tokens.push({ kind: 'control', value: '\n' });
      continue;
    }
    if (shellControls.has(character)) {
      finishWord();
      const next = command[index + 1];
      if ((character === '&' || character === '|') && next === character) {
        tokens.push({ kind: 'control', value: `${character}${character}` });
        index += 1;
      } else {
        tokens.push({ kind: 'control', value: character });
      }
      continue;
    }
    word += character;
  }
  finishWord();
  return tokens;
}

function commandSegments(command: string): string[][] {
  const segments: string[][] = [];
  let segment: string[] = [];
  for (const token of tokenizeShellCommand(command)) {
    if (token.kind === 'word') {
      segment.push(token.value);
      continue;
    }
    if (segment.length > 0) segments.push(segment);
    segment = [];
  }
  if (segment.length > 0) segments.push(segment);
  return segments;
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function executableIndex(words: readonly string[]): number | undefined {
  let index = 0;
  while (index < words.length) {
    while (isEnvironmentAssignment(words[index] ?? '')) index += 1;
    const wrapper = basename(words[index] ?? '');
    if (wrapper === 'env') {
      index += 1;
      while (index < words.length) {
        const word = words[index] ?? '';
        if (isEnvironmentAssignment(word)) {
          index += 1;
          continue;
        }
        if (['-u', '--unset', '-C', '--chdir', '-S', '--split-string'].includes(word)) {
          index += 2;
          continue;
        }
        if (word.startsWith('-')) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (wrapper === 'command' || wrapper === 'exec') {
      index += 1;
      while ((words[index] ?? '').startsWith('-')) index += 1;
      continue;
    }
    break;
  }
  return index < words.length ? index : undefined;
}

function readAgentSelector(words: readonly string[]): {
  dynamic: boolean;
  targetAgentId?: string;
} {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (word === '--') break;
    const target = word === '--agent' ? words[index + 1] : word.slice('--agent='.length);
    if (word !== '--agent' && !word.startsWith('--agent=')) continue;
    const normalized = target?.trim();
    if (!normalized || !/^[a-z0-9][a-z0-9-]*$/u.test(normalized)) {
      return { dynamic: true };
    }
    return { dynamic: false, targetAgentId: normalized };
  }
  return { dynamic: false };
}

function readToolCommand(words: readonly string[]): string | undefined {
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? '';
    if (word === '--agent') {
      index += 1;
      continue;
    }
    if (word.startsWith('--agent=')) continue;
    if (word === '--') return undefined;
    if (!word.startsWith('-')) return word;
  }
  return undefined;
}

function recommendedTool(command: string | undefined): string | undefined {
  if (command === 'gh') return 'agent_system_github';
  if (command === 'git') return 'agent_system_git';
  if (command === 'worktree') return 'agent_system_git_worktree';
  return undefined;
}

function operatorInvocation(words: readonly string[]): AgentOperatorInvocation | undefined {
  const index = executableIndex(words);
  if (index === undefined) return undefined;
  const executable = words[index] ?? '';
  if (basename(executable) !== 'openclaw') return undefined;
  const namespace = words[index + 1]?.toLowerCase();
  const surface = words[index + 2]?.toLowerCase();
  if (!['agent-system', 'as'].includes(namespace ?? '')) return undefined;
  if (surface !== 'tool' && surface !== 'credentials') return undefined;

  const argumentsAfterSurface = words.slice(index + 3);
  const target = readAgentSelector(argumentsAfterSurface);
  return {
    ...(surface === 'tool'
      ? { recommendedTool: recommendedTool(readToolCommand(argumentsAfterSurface)) }
      : {}),
    surface,
    targetAgentDynamic: target.dynamic,
    ...(target.targetAgentId ? { targetAgentId: target.targetAgentId } : {}),
  };
}

function managedShimInvocation(
  words: readonly string[],
  cwd: string | undefined,
  directories: readonly string[],
): AgentOperatorInvocation | undefined {
  const index = executableIndex(words);
  if (index === undefined) return undefined;
  const executable = words[index] ?? '';
  if (!executable.includes('/')) return undefined;
  const executablePath = isAbsolute(executable)
    ? resolve(executable)
    : cwd
      ? resolve(cwd, executable)
      : undefined;
  if (!executablePath) return undefined;
  if (!directories.some((directory) => dirname(executablePath) === resolve(directory))) {
    return undefined;
  }

  const name = basename(executablePath);
  if (!['agent-system-tool', 'gh', 'git'].includes(name)) return undefined;
  const command = name === 'agent-system-tool' ? words[index + 1]?.toLowerCase() : name;
  return {
    ...(recommendedTool(command) ? { recommendedTool: recommendedTool(command) } : {}),
    surface: 'shim',
    targetAgentDynamic: false,
  };
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Inspect direct shell command segments without attempting arbitrary script evaluation. */
export default function inspectAgentCommand(
  toolName: string,
  params: Record<string, unknown>,
  options: InspectAgentCommandOptions = {},
): AgentCommandInspection {
  if (!commandToolNames.has(toolName)) return { operatorInvocations: [], status: 'irrelevant' };

  const cwd = stringProperty(params, 'cwd') ?? stringProperty(params, 'workdir');
  const command = stringProperty(params, 'command') ?? stringProperty(params, 'cmd');
  if (!command) {
    return {
      ...(cwd ? { cwd } : {}),
      operatorInvocations: [],
      status: 'command',
    };
  }

  const managedDirectories = options.managedExecutableDirectories ?? [];
  const operatorInvocations = commandSegments(command).flatMap((segment) => {
    const invocation =
      operatorInvocation(segment) ?? managedShimInvocation(segment, cwd, managedDirectories);
    return invocation ? [invocation] : [];
  });
  return {
    ...(cwd ? { cwd } : {}),
    operatorInvocations,
    status: 'command',
  };
}
