import assert from 'node:assert/strict';

import { completeCliOneShot, type CliFlushStream } from '../cli/one-shot.ts';

function recordingStream(name: string, events: string[], error?: Error): CliFlushStream {
  return {
    write(value, callback) {
      assert.equal(value, '');
      events.push(name);
      callback(error);
      return true;
    },
  };
}

describe('cli/one-shot', () => {
  it('should flush both output streams before exiting', async () => {
    const events: string[] = [];

    await completeCliOneShot(2, {
      exit: (code) => events.push(`exit:${code}`),
      stderr: recordingStream('stderr', events),
      stdout: recordingStream('stdout', events),
    });

    assert.deepEqual(events, ['stdout', 'stderr', 'exit:2']);
  });

  it('should not exit when output flushing fails', async () => {
    const events: string[] = [];

    await assert.rejects(
      completeCliOneShot(1, {
        exit: (code) => events.push(`exit:${code}`),
        stderr: recordingStream('stderr', events),
        stdout: recordingStream('stdout', events, new Error('flush failed')),
      }),
      /flush failed/,
    );

    assert.deepEqual(events, ['stdout']);
  });
});
