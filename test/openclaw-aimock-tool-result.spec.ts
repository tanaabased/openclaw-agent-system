import assert from 'node:assert/strict';

import hasOpenClawAIMockToolResult, {
  matchesOpenClawAIMockToolCallId,
  openClawAIMockToolResultText,
} from '../scripts/aimock-tool-result.ts';

const toolCallId = 'call_example';

describe('scripts/aimock-tool-result', () => {
  it('should recognize only the requested scenario tool result', () => {
    assert.equal(
      hasOpenClawAIMockToolResult(
        [{ role: 'assistant' }, { role: 'tool', tool_call_id: toolCallId }],
        toolCallId,
      ),
      true,
    );
    assert.equal(
      hasOpenClawAIMockToolResult(
        [
          {
            role: 'tool',
            tool_call_id: `${toolCallId}_fc-observed_123`,
          },
        ],
        toolCallId,
      ),
      true,
    );
    assert.equal(
      hasOpenClawAIMockToolResult([{ role: 'tool', tool_call_id: 'call_other' }], toolCallId),
      false,
    );
  });

  it('should reject unrelated suffixes that merely share the authored prefix', () => {
    assert.equal(
      matchesOpenClawAIMockToolCallId(`${toolCallId}_fc-observed_123`, toolCallId),
      true,
    );
    assert.equal(
      matchesOpenClawAIMockToolCallId(`${toolCallId}_message-observed`, toolCallId),
      false,
    );
  });

  it('should return text only for the requested tool result', () => {
    assert.equal(
      openClawAIMockToolResultText(
        [
          { content: 'other', role: 'tool', tool_call_id: 'call_other' },
          {
            content: [{ text: '{"login":"emoriwan"}' }],
            role: 'tool',
            tool_call_id: `${toolCallId}_fc-observed_123`,
          },
        ],
        toolCallId,
      ),
      '{"login":"emoriwan"}',
    );
  });
});
