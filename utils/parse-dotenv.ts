export interface DotenvParseDiagnostic {
  code:
    'dotenv-duplicate-variable' | 'dotenv-escape' | 'dotenv-nul' | 'dotenv-syntax' | 'dotenv-value';
  line: number;
  message: string;
}

export type DotenvParseResult =
  | {
      status: 'invalid';
      diagnostics: DotenvParseDiagnostic[];
    }
  | {
      status: 'valid';
      values: Record<string, string>;
    };

type ParsedDotenvValue =
  | { status: 'invalid'; code: 'dotenv-escape' | 'dotenv-value'; message: string }
  | { status: 'valid'; value: string };

const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function quotedRemainderIsValid(remainder: string): boolean {
  const trimmed = remainder.trimStart();
  return trimmed === '' || trimmed.startsWith('#');
}

function parseSingleQuotedValue(input: string): ParsedDotenvValue {
  const closingQuote = input.indexOf("'", 1);
  if (closingQuote < 0 || !quotedRemainderIsValid(input.slice(closingQuote + 1))) {
    return {
      status: 'invalid',
      code: 'dotenv-value',
      message: 'Single-quoted dotenv values must close before an optional comment.',
    };
  }

  return { status: 'valid', value: input.slice(1, closingQuote) };
}

function parseDoubleQuotedValue(input: string): ParsedDotenvValue {
  let value = '';
  for (let index = 1; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (!quotedRemainderIsValid(input.slice(index + 1))) {
        return {
          status: 'invalid',
          code: 'dotenv-value',
          message: 'Double-quoted dotenv values may be followed only by an optional comment.',
        };
      }
      return { status: 'valid', value };
    }

    if (character !== '\\') {
      value += character;
      continue;
    }

    const escaped = input[index + 1];
    const escapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escaped === undefined || escapes[escaped] === undefined) {
      return {
        status: 'invalid',
        code: 'dotenv-escape',
        message: 'Double-quoted dotenv values contain an unsupported escape sequence.',
      };
    }
    value += escapes[escaped];
    index += 1;
  }

  return {
    status: 'invalid',
    code: 'dotenv-value',
    message: 'Double-quoted dotenv values must close before the end of the line.',
  };
}

function parseUnquotedValue(input: string): ParsedDotenvValue {
  const commentIndex = /[ \t]#/.exec(input)?.index;
  const value = commentIndex === undefined ? input : input.slice(0, commentIndex);
  return { status: 'valid', value: value.trimEnd() };
}

function parseValue(input: string): ParsedDotenvValue {
  const trimmed = input.trimStart();
  if (trimmed.startsWith("'")) return parseSingleQuotedValue(trimmed);
  if (trimmed.startsWith('"')) return parseDoubleQuotedValue(trimmed);
  return parseUnquotedValue(trimmed);
}

/** Parse the supported dotenv subset without interpolation or shell evaluation. */
export default function parseDotenv(source: string): DotenvParseResult {
  if (source.includes('\u0000')) {
    return {
      status: 'invalid',
      diagnostics: [
        {
          code: 'dotenv-nul',
          line: 1,
          message: 'Dotenv files may not contain NUL bytes.',
        },
      ],
    };
  }

  const values = new Map<string, string>();
  const diagnostics: DotenvParseDiagnostic[] = [];
  const lines = source.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  for (const [lineIndex, originalLine] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    const trimmed = originalLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const assignment = trimmed.replace(/^export[ \t]+/, '');
    const separator = assignment.indexOf('=');
    const name = separator < 0 ? '' : assignment.slice(0, separator).trim();
    if (separator < 0 || !environmentNamePattern.test(name)) {
      diagnostics.push({
        code: 'dotenv-syntax',
        line: lineNumber,
        message: 'Dotenv entries must use NAME=value with a valid environment-variable name.',
      });
      continue;
    }

    if (values.has(name)) {
      diagnostics.push({
        code: 'dotenv-duplicate-variable',
        line: lineNumber,
        message: `Dotenv variable ${name} is declared more than once in the same file.`,
      });
      continue;
    }

    const parsedValue = parseValue(assignment.slice(separator + 1));
    if (parsedValue.status === 'invalid') {
      diagnostics.push({
        code: parsedValue.code,
        line: lineNumber,
        message: parsedValue.message,
      });
      continue;
    }
    values.set(name, parsedValue.value);
  }

  if (diagnostics.length > 0) return { status: 'invalid', diagnostics };
  return { status: 'valid', values: Object.fromEntries(values) };
}
