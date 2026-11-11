import assert from 'node:assert/strict';

import mentionLinks from '../channels/github/presentation/mention-links.ts';

describe('channels/github/presentation/mention-links', () => {
  it('should link ordinary handles without changing surrounding markdown or line endings', () => {
    const longest = 'a'.repeat(39);
    assert.equal(
      mentionLinks(`Ask @Octo-Cat, **@a** and '@${longest}'.\r\n\r\n> @b\r- @c!`),
      `Ask [@Octo-Cat](https://github.com/Octo-Cat), **[@a](https://github.com/a)** and '[@${longest}](https://github.com/${longest})'.\r\n\r\n> [@b](https://github.com/b)\r- [@c](https://github.com/c)!`,
    );
  });

  it('should preserve inline, fenced, indented and nested code', () => {
    const code = [
      '`@inline` and ``@two ` @three``',
      '',
      '~~~~ts',
      '@fenced',
      '~~~~',
      '',
      '    @indented',
      '',
      '> ```',
      '> @quoted-code',
      '> ```',
      '',
      '- item',
      '',
      '      @list-code',
    ].join('\n');
    assert.equal(mentionLinks(code), code);
  });

  it('should preserve link labels, destinations, images and reference definitions', () => {
    const links = [
      '[@label](https://example.com/@destination "@title")',
      '![**@image**](https://example.com/@image)',
      '[@reference][profile] and [@shortcut]',
      '',
      '[profile]: https://example.com/@profile "@title"',
      '[@shortcut]: https://example.com/@shortcut',
      '',
      '<https://example.com/@autolink> <person@example.com>',
    ].join('\n');
    assert.equal(mentionLinks(links), links);
    assert.equal(
      mentionLinks('@outside [@inside](https://example.com) @after'),
      '[@outside](https://github.com/outside) [@inside](https://example.com) [@after](https://github.com/after)',
    );
  });

  it('should leave emails, urls, scoped names and team references unchanged', () => {
    const literals = [
      'person@example.com',
      'person+tag@domain',
      'person.name@domain.example',
      '"quoted local"@domain',
      'имя@example.com',
      'https://example.com/@path?user=@query',
      'https://example.com/path_*@emphasized*',
      'www.example.com/@path',
      'mailto:@email',
      'file/@path',
      '@org/team',
      '@scope/package',
      '@domain.example',
    ].join(' ');
    assert.equal(mentionLinks(literals), literals);
  });

  it('should leave escaped, invalid and uncertain handles unchanged', () => {
    const literals = [
      '\\@escaped',
      '&#64;entity',
      '@-leading',
      '@trailing-',
      '@double--hyphen',
      '@under_score',
      '@unicodeé',
      'prefix@embedded',
      '@@doubled',
      `@${'a'.repeat(40)}`,
      '[@unresolved]',
      '`unclosed @code',
    ];
    for (const literal of literals) assert.equal(mentionLinks(literal), literal);
  });

  it('should leave html and uncertain inline html context unchanged', () => {
    const html = '<div>\n@block\n</div>\n\n<code>@inline</code>\n\n<!-- @hidden -->';
    assert.equal(mentionLinks(html), html);
    assert.equal(
      mentionLinks(`${html}\n\n@outside`),
      `${html}\n\n[@outside](https://github.com/outside)`,
    );
  });

  it('should preserve entities, escaping and non-mention text without reserialization', () => {
    const source = 'A &amp; B \\*literal\\* — @octocat.\r\n';
    assert.equal(
      mentionLinks(source),
      'A &amp; B \\*literal\\* — [@octocat](https://github.com/octocat).\r\n',
    );
    assert.equal(mentionLinks(''), '');
    assert.equal(mentionLinks('No handles.\r\n'), 'No handles.\r\n');
  });
});
