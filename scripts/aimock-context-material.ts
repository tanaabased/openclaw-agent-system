import assert from 'node:assert/strict';

import {
  getTextContent,
  type ChatCompletionRequest,
  type FixtureResponse,
} from '@copilotkit/aimock';

import { openClawAIMockToolResultText } from './aimock-tool-result.ts';

/** Consume shared context pages through the same tool calls a native model receives. */
export default function contextMaterialExchange(request: ChatCompletionRequest): {
  request: ChatCompletionRequest;
  pending?: FixtureResponse;
} {
  const messages = [...request.messages];
  const start = Math.max(
    0,
    messages.findLastIndex(({ role }) => role === 'user'),
  );
  for (let index = start; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'tool') continue;
    let context: Record<string, unknown>;
    try {
      context = JSON.parse(getTextContent(message.content) ?? '');
    } catch {
      continue;
    }
    if (!context?.contextMaterials) continue;
    const owner =
      messages
        .flatMap((item) => item.tool_calls ?? [])
        .find((call) => call.id === message.tool_call_id)?.function.name ?? 'agent_system_dispatch';
    const materials = context.contextMaterials as {
      fields: Array<{
        path: string[];
        digest: string;
        length: number;
        request: Record<string, unknown>;
      }>;
      aliases: Array<{ path: string[]; from: string[] }>;
    };
    const locate = (path: string[]) => {
      let parent = context;
      for (const name of path.slice(0, -1)) parent = parent[name] as Record<string, unknown>;
      return { parent, name: path.at(-1)! };
    };
    for (const [fieldIndex, field] of [...materials.fields]
      .sort((a, b) => a.path.length - b.path.length)
      .entries()) {
      let next: Record<string, unknown> | undefined = field.request;
      let text = '';
      while (next) {
        const id = `${message.tool_call_id}_material_${fieldIndex}_${text.length}`;
        const observed = openClawAIMockToolResultText(messages, id);
        if (observed === undefined)
          return {
            request,
            pending: {
              toolCalls: [{ id, name: owner, arguments: JSON.stringify(next) }],
            },
          };
        const result = JSON.parse(observed);
        assert.equal(result.status, 'material');
        assert.equal(result.materialPage.digest, field.digest);
        assert.equal(result.materialPage.offset, text.length);
        assert.ok(result.materialPage.text.length > 0);
        text += result.materialPage.text;
        assert.ok(text.length <= field.length);
        next = result.next;
      }
      assert.equal(text.length, field.length);
      const { parent, name } = locate(field.path);
      parent[name] = JSON.parse(text);
    }
    for (const alias of materials.aliases) {
      const source = locate(alias.from);
      const destination = locate(alias.path);
      destination.parent[destination.name] = source.parent[source.name];
    }
    delete context.contextMaterials;
    messages[index] = { ...message, content: JSON.stringify(context) };
  }
  return { request: { ...request, messages } };
}
