import assert from 'node:assert/strict';

import parseDotenv from '../utils/parse-dotenv.ts';

describe('utils/parse-dotenv', () => {
  it('should parse the supported literal, quoted, comment, and export forms', () => {
    assert.deepEqual(
      parseDotenv(`
# ignored comment
PLAIN=literal value
export EXPORTED = available
EMPTY=
HASH=value#literal
COMMENTED=value # ignored comment
SINGLE=' single # literal '
DOUBLE="line one\\nline two\\t\\"quoted\\""
DOLLARS=$HOST_VALUE \${OTHER_VALUE}
EQUALS=left=right
`),
      {
        status: 'valid',
        values: {
          PLAIN: 'literal value',
          EXPORTED: 'available',
          EMPTY: '',
          HASH: 'value#literal',
          COMMENTED: 'value',
          SINGLE: ' single # literal ',
          DOUBLE: 'line one\nline two\t"quoted"',
          DOLLARS: '$HOST_VALUE ${OTHER_VALUE}',
          EQUALS: 'left=right',
        },
      },
    );
  });

  it('should reject malformed names, duplicate variables, invalid values, escapes, and nuls', () => {
    for (const [source, code] of [
      ['not-valid=value', 'dotenv-syntax'],
      ['DUPLICATE=one\nDUPLICATE=two', 'dotenv-duplicate-variable'],
      ["BROKEN='value", 'dotenv-value'],
      ['BROKEN="value\\q"', 'dotenv-escape'],
      ['NUL=value\u0000tail', 'dotenv-nul'],
    ] as const) {
      const result = parseDotenv(source);
      assert.equal(result.status, 'invalid');
      if (result.status !== 'invalid') continue;
      assert.equal(
        result.diagnostics.some((diagnostic) => diagnostic.code === code),
        true,
      );
      assert.equal(
        result.diagnostics.some(({ message }) => message.includes('value\u0000tail')),
        false,
      );
    }
  });
});
