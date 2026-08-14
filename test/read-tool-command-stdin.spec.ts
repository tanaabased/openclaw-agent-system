import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import readToolCommandStdin, {
  maximumToolCommandStdinBytes,
} from '../utils/read-tool-command-stdin.ts';

describe('utils/read-tool-command-stdin', () => {
  it('should return no input for an absent or interactive stream', async () => {
    const terminal = Readable.from(['ignored']) as Readable & { isTTY?: boolean };
    terminal.isTTY = true;

    assert.equal(await readToolCommandStdin(undefined), undefined);
    assert.equal(await readToolCommandStdin(terminal), undefined);
  });

  it('should preserve redirected utf8 input', async () => {
    const input = Readable.from(['{"title":', '"test"}\n']);

    assert.equal(await readToolCommandStdin(input), '{"title":"test"}\n');
  });

  it('should reject redirected input above the byte limit', async () => {
    const input = Readable.from(['a'.repeat(maximumToolCommandStdinBytes + 1)]);

    await assert.rejects(() => readToolCommandStdin(input), RangeError);
  });
});
