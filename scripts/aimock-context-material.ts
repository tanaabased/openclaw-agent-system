import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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
    const original = messages
      .flatMap((item) => item.tool_calls ?? [])
      .find((call) => call.id === message.tool_call_id)?.function;
    const transport = context.materialTransport as { tool: string };
    assert.equal(transport.tool, original?.name);
    const owner = transport.tool;
    const materials = context.contextMaterials as {
      inputFields?: string[];
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
        const id = `call_material_${createHash('sha256')
          .update(JSON.stringify([message.tool_call_id, fieldIndex, text.length]))
          .digest('hex')
          .slice(0, 16)}`;
        const observed = openClawAIMockToolResultText(messages, id);
        if (observed === undefined)
          return {
            request,
            pending: {
              toolCalls: [
                {
                  id,
                  name: owner,
                  arguments: JSON.stringify(
                    materials.inputFields
                      ? {
                          ...Object.fromEntries(
                            materials.inputFields.map((field) => [
                              field,
                              JSON.parse(original?.arguments ?? '{}')[field],
                            ]),
                          ),
                          ...next,
                        }
                      : next,
                  ),
                },
              ],
            },
          };
        const result = JSON.parse(observed);
        assert.deepEqual(result.materialTransport, transport);
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
      const value = JSON.parse(text);
      parent[name] =
        value && typeof value === 'object' && !Array.isArray(value)
          ? { ...(parent[name] as Record<string, unknown>), ...value }
          : value;
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
