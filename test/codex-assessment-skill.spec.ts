import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import codexAssessmentSkill from '../agent/codex-assessment-skill.ts';

describe('agent/codex-assessment-skill', () => {
  let cwd: string, skill: { name: string; path: string; scope: string; enabled: boolean };
  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'assessment-skill-')));
    skill = { name: 'company:assess', path: join(cwd, 'SKILL.md'), scope: 'user', enabled: true };
    await writeFile(skill.path, '---\nname: assess\n---\nAssess the issue.');
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });
  const catalog =
    (cwd: string, skills: unknown[]) => async (method: string, params: Record<string, unknown>) => {
      assert.equal(method, 'skills/list');
      assert.deepEqual(params, { cwds: [cwd], forceReload: true });
      return { data: [{ cwd, skills, errors: [] }] };
    };

  it('should resolve bare and qualified ids with optional invocation sigils to one active skill', async () => {
    for (const id of [
      'assess',
      '$assess',
      'company:assess',
      '$company:assess',
      ' $company:assess ',
    ]) {
      const resolved = await codexAssessmentSkill(catalog(cwd, [skill]), cwd, id);
      assert.equal(resolved.name, 'company:assess');
      assert.equal(resolved.path, skill.path);
      assert.match(resolved.digest, /^[a-f0-9]{64}$/u);
    }
  });

  it('should reject missing disabled ambiguous and unsupported sources without default substitution', async () => {
    for (const skills of [[], [{ ...skill, enabled: false }]])
      await assert.rejects(
        codexAssessmentSkill(catalog(cwd, skills), cwd, 'assess'),
        /skill-unavailable/,
      );
    const duplicates = [skill, { ...skill, name: 'other:assess' }];
    await assert.rejects(
      codexAssessmentSkill(catalog(cwd, duplicates), cwd, 'assess'),
      /skill-ambiguous/,
    );
    assert.equal(
      (await codexAssessmentSkill(catalog(cwd, duplicates), cwd, 'company:assess')).name,
      skill.name,
    );
    for (const path of ['relative/SKILL.md', 'https://example.test/SKILL.md'])
      await assert.rejects(
        codexAssessmentSkill(catalog(cwd, [{ ...skill, path }]), cwd, 'assess'),
        /source-unsupported/,
      );
    await assert.rejects(
      codexAssessmentSkill(async () => ({ data: [] }), cwd, 'assess'),
      /discovery-invalid/,
    );
    await assert.rejects(
      codexAssessmentSkill(
        catalog(cwd, [{ ...skill, path: join(cwd, 'missing/SKILL.md') }]),
        cwd,
        'assess',
      ),
      /skill-unreadable/,
    );
  });

  it('should infer the plugin from a unique active id and ignore disabled collisions', async () => {
    const skills = [skill, { ...skill, name: 'other:assess', enabled: false }];
    assert.equal(
      (await codexAssessmentSkill(catalog(cwd, skills), cwd, '$assess')).name,
      'company:assess',
    );
    assert.equal(
      (
        await codexAssessmentSkill(
          catalog(cwd, [{ ...skill, name: 'company:Assessment' }]),
          cwd,
          'Assessment',
        )
      ).name,
      'company:Assessment',
    );
    await assert.rejects(
      codexAssessmentSkill(catalog(cwd, [skill, { ...skill, name: 'assess' }]), cwd, 'assess'),
      /skill-ambiguous/,
    );
  });
});
