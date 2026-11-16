import assert from 'node:assert/strict';

import parseAgentManifest, { parseManifestYaml } from '../manifest/parse.ts';

describe('manifest/yaml reuse', () => {
  it('should resolve explicit overrides and shallow merges without exposing definitions', () => {
    const parsed = parseAgentManifest(`schema-version: 1
agent: {id: test}
definitions:
  arbitrary: [null, true, 3]
  common: &common {shell: bash, apply: echo base}
setup-agent: {<<: *common, apply: echo local}
`);
    assert.equal(parsed.status, 'valid', JSON.stringify(parsed.diagnostics));
    if (parsed.status !== 'valid') return;
    assert.equal('definitions' in parsed.manifest, false);
    assert.deepEqual(parsed.manifest.setup?.steps[0]?.apply, {
      kind: 'shell',
      script: 'echo local',
      shell: 'bash',
      timeoutSeconds: 600,
    });
    assert.deepEqual(
      parseManifestYaml(
        'base: &base {nested: {one: 1, two: 2}}\nresult: {<<: *base, nested: {one: 3}}',
      ),
      {
        status: 'valid',
        value: { base: { nested: { one: 1, two: 2 } }, result: { nested: { one: 3 } } },
      },
    );
  });

  it('should keep core scalar semantics and accept core tags even with a version directive', () => {
    for (const prefix of ['', '%YAML 1.1\n---\n']) {
      assert.deepEqual(
        parseManifestYaml(
          `${prefix}text: !!str 123\nmap: !!map {yes: yes, on: on, octal: 012}\nseq: !!seq [!!int 2, !!bool true, !!null null]`,
        ),
        {
          status: 'valid',
          value: { text: '123', map: { yes: 'yes', on: 'on', octal: 12 }, seq: [2, true, null] },
        },
      );
    }
  });

  it('should reject unsafe graphs, unsupported tags and invalid merge operands', () => {
    for (const source of [
      'a: *missing',
      'a: &a [*a]',
      'a: &a {<<: *a}',
      'a: !execute echo',
      'a: !!timestamp 2026-01-01',
      'a: {<<: 3}',
      'a: {<<: [false]}',
      'a: &a [1, 2, 3, 4, 5]\nb: &b [*a, *a, *a, *a, *a]\nc: &c [*b, *b, *b, *b, *b]\nd: [*c, *c, *c, *c, *c]',
    ])
      assert.equal(parseManifestYaml(source).status, 'invalid', source);
    assert.deepEqual(parseManifestYaml('a: &a {value: 1}\nb: *a'), {
      status: 'valid',
      value: { a: { value: 1 }, b: { value: 1 } },
    });
  });

  it('should bound repeated merge traversal before conversion or consumer recursion', () => {
    const source = [
      'a0: &a0 {value: 1}',
      ...Array.from(
        { length: 24 },
        (_, index) => `a${index + 1}: &a${index + 1} {<<: [*a${index}, *a${index}]}`,
      ),
    ].join('\n');
    const result = parseManifestYaml(source);
    assert.equal(result.status, 'invalid');
    if (result.status === 'invalid')
      assert.equal(result.diagnostics[0]?.code, 'yaml-expansion-limit');
  });

  it('should retain strict operational keys and require definitions to be a mapping', () => {
    for (const suffix of [
      'definitions: []',
      'definitons: {}',
      'setup-agent: {apply: echo ok, helper: true}',
    ])
      assert.equal(
        parseAgentManifest(`schema-version: 1\nagent: {id: test}\n${suffix}`).status,
        'invalid',
      );
  });
});
