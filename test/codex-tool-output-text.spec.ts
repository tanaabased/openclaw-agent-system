import assert from 'node:assert/strict';

import codexToolOutputText from '../agent/codex-tool-output-text.ts';

describe('agent/codex-tool-output-text', () => {
  it('should preserve strings and ordered text parts without trimming or decoding', () => {
    const text = '  <input>one &amp; two\n</input> ';
    assert.equal(codexToolOutputText(text), text);
    assert.equal(
      codexToolOutputText([
        { type: 'input_text', text: text.slice(0, 12) },
        { type: 'input_text', text: text.slice(12) },
      ]),
      text,
    );
  });

  it('should reject malformed and mixed media output without extracting a partial envelope', () => {
    for (const value of [
      null,
      [],
      { text: 'envelope' },
      [{ type: 'input_text', text: 1 }],
      [{ type: 'text', text: 'envelope' }],
      [
        { type: 'input_text', text: 'envelope' },
        { type: 'input_image', image_url: 'image' },
      ],
    ])
      assert.equal(codexToolOutputText(value), undefined);
  });
});
