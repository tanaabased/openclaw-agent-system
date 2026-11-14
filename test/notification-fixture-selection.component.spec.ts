import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

function execute(code: string, fixtures: unknown, records: unknown[]) {
  return spawnSync('jq', ['-e', '--argjson', 'fixtures', JSON.stringify(fixtures), code], {
    input: JSON.stringify([{ records }]),
    encoding: 'utf8',
  });
}

describe('examples/openclaw-issue-intake fixture selection', () => {
  it('should select all three pending owners without optional context and reject missing or duplicate owners', async () => {
    const source = await readFile('examples/openclaw-issue-intake/README.md', 'utf8');
    const code = [...source.matchAll(/jq -es --slurpfile fixtures "[^"]+" '([^']+)'/gu)]
      .map((match) => match[1]!)
      .find((text) => text.includes('all(.[]; .threadId == null'));
    assert.ok(code);
    const fixtures = [[1, 2, 3].map((id) => ({ id: `intake-${id}` }))];
    const owned = [1, 2, 3].map((id) => ({ id: `dispatch-${id}`, intakeId: `intake-${id}` }));
    const unrelated = [{ id: 'blocked', intakeId: 'other', blocker: 'dispatch-issue-closed' }];
    const valid = execute(code, fixtures, [...owned, ...unrelated]);
    assert.equal(valid.status, 0, valid.stderr);
    assert.notEqual(execute(code, fixtures, [...owned.slice(1), ...unrelated]).status, 0);
    assert.notEqual(execute(code, fixtures, [...owned, owned[0]!, ...unrelated]).status, 0);
    assert.notEqual(execute(code, fixtures, [owned[0]!, owned[0]!, owned[2]!]).status, 0);
  });

  it('should reject unstarted assessments and retain readable diagnostics without native turns', async () => {
    const source = await readFile('examples/openclaw-issue-intake/README.md', 'utf8');
    const start = [...source.matchAll(/jq -es --slurpfile fixtures "[^"]+" '([^']+)'/gu)]
      .map((match) => match[1]!)
      .find((text) => text.includes('.claimAccepted == true'));
    const diagnostic = [...source.matchAll(/jq -s --slurpfile fixtures "[^"]+" '([^']+)'/gu)]
      .map((match) => match[1]!)
      .find((text) => text.includes('assessmentTurn:'));
    assert.ok(start && diagnostic);
    const records = [1, 2, 3].map((id) => ({
      id: `dispatch-${id}`,
      intakeId: `intake-${id}`,
      threadId: `thread-${id}`,
      claimAccepted: true,
      sessionCreation: { verified: true },
    }));
    const fixtures = [records.map(({ intakeId }) => ({ id: intakeId }))];
    const unstarted = execute(start, fixtures, records);
    assert.equal(unstarted.status, 1);
    assert.equal(unstarted.stderr, '');
    const result = execute(diagnostic, fixtures, records);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).count, 3);
  });
});

for (const scenario of ['openclaw-pr-journey', 'openclaw-pr-discovery']) {
  describe(`examples/${scenario} fixture selection`, () => {
    it('should retain the exact owner among context-free records and reject missing or duplicate owners', async () => {
      const source = await readFile(`examples/${scenario}/README.md`, 'utf8');
      const codes = new Set(
        [...source.matchAll(/jq -es --slurpfile owner "[^"]+" '([^']+)'/gu)].map(
          (match) => match[1]!,
        ),
      );
      assert.ok(codes.size > 0);
      const owned = {
        id: 'owned',
        feedback: {
          events: [1, 2].map(() => ({ phase: 'delivered', turn: { status: 'consumed' } })),
        },
      };
      const unrelated = { id: 'blocked', blocker: 'dispatch-issue-closed' };
      for (const code of codes) {
        const run = (records: unknown[]) =>
          spawnSync('jq', ['-e', '--argjson', 'owner', JSON.stringify([owned]), code], {
            input: JSON.stringify([{ records }]),
            encoding: 'utf8',
          });
        const valid = run([unrelated, owned]);
        assert.equal(valid.status, 0, valid.stderr);
        assert.notEqual(run([unrelated]).status, 0);
        assert.notEqual(run([owned, unrelated, owned]).status, 0);
      }
    });
  });
}
