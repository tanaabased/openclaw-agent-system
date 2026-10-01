const { reporters, Runner } = require('mocha');

const reportAfterMs = 500;

module.exports = class UnitTimingReporter extends reporters.Spec {
  constructor(runner, options) {
    super(runner, options);
    const slow = [];
    runner.on(Runner.constants.EVENT_TEST_END, (test) => {
      if (test.duration >= reportAfterMs)
        slow.push({ duration: test.duration, title: test.fullTitle() });
    });
    runner.on(Runner.constants.EVENT_RUN_END, () => {
      if (slow.length === 0) return;
      slow.sort((left, right) => right.duration - left.duration);
      process.stderr.write(
        `\nMocha checks taking at least ${reportAfterMs} ms (${slow.length}):\n`,
      );
      for (const test of slow) process.stderr.write(`  ${test.duration} ms  ${test.title}\n`);
    });
  }
};
