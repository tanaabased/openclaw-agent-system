import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import openClawSkill from '../agent/openclaw-skill.ts';

describe('agent/openclaw-skill', () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'openclaw-skill-')));
    await mkdir(join(root, 'ordinary'));
    await writeFile(join(root, 'ordinary', 'SKILL.md'), '# ordinary assessment');
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  for (const invalid of [
    'missing',
    'disabled',
    'hidden',
    'ineligible',
    'ambiguous',
    'unsupported',
    'unreadable',
  ]) {
    it(`should reject ${invalid} skill discovery and accept the corrected catalog`, async () => {
      const valid = [
        {
          name: 'ordinary-assessment',
          skillKey: 'company:ordinary-assessment',
          filePath: join(root, 'ordinary', 'SKILL.md'),
          eligible: true,
          modelVisible: true,
          disabled: false,
          source: 'openclaw-managed',
        },
      ];
      let skills: Array<Record<string, unknown>> = structuredClone(valid);
      if (invalid === 'missing') skills = [];
      if (invalid === 'disabled') skills[0]!.disabled = true;
      if (invalid === 'hidden') skills[0]!.modelVisible = false;
      if (invalid === 'ineligible') skills[0]!.eligible = false;
      if (invalid === 'ambiguous') skills.push({ ...skills[0] });
      if (invalid === 'unsupported') skills[0]!.filePath = 'relative/SKILL.md';
      if (invalid === 'unreadable') skills[0]!.filePath = join(root, 'missing', 'SKILL.md');
      const request = async (method: string, params: Record<string, unknown>) => {
        assert.equal(method, 'skills.status');
        assert.deepEqual(params, { agentId: 'receiver', sessionKey: 'issue' });
        return { skills };
      };
      const expected = { agentId: 'receiver', key: 'issue' };
      await assert.rejects(
        openClawSkill(request, expected, 'company:ordinary-assessment'),
        /(?:dispatch-assessment-skill|assessment-skill)/u,
      );
      skills = valid;
      const selected = await openClawSkill(request, expected, 'company:ordinary-assessment');
      assert.equal(selected.name, 'ordinary-assessment');
      assert.equal(selected.path, join(root, 'ordinary', 'SKILL.md'));
    });
  }
});
